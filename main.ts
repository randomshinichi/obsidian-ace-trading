import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, SuggestModal } from 'obsidian';

// Types
type Action = 'long' | 'short';
type Side = 'in' | 'out';

interface Fill {
  side: Side;
  t: string; // ISO UTC
  base: number;
  quote: number;
  price: number;
  note?: string;
  txs?: string[];
}

interface Metrics {
  status: 'open' | 'closed';
  position: number | null;
  avg_entry: number | null;
  avg_exit: number | null;
  realized_pnl: number | null;
  r_multiple: number | null;
  win: boolean | null;
  last_fill_at?: string | null;
  computed_at?: string;
}

interface TradeFrontmatter {
  id: string;
  schema_version: number; // 2
  timestamp: string; // ISO
  pair: string; // e.g., HYPE/USDT
  action: Action;
  account?: string;
  quote?: string;
  initial_stop?: number;
  closed_at?: string;
  fills?: Fill[];
  metrics?: Metrics;
}

interface AceTradingSettings {
  tradesRoot: string;
  filenamePattern: string; // supports ${YYYY}${MM}${DD}${HH}${mm}, ${PAIR}, ${ACTION}
  bodyTemplatePath: string; // markdown template for body
}

const DEFAULT_SETTINGS: AceTradingSettings = {
  tradesRoot: 'Efforts/Ongoing/Trading/Trades',
  filenamePattern: 'T-${YYYY}${MM}${DD}-${HH}${mm}-${PAIR}-${ACTION}',
  bodyTemplatePath: 'utils/templates/trading/trade-body.md'
};

// Helpers
const pad = (n: number) => String(n).padStart(2, '0');
const toIsoUtc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00.000Z`;
const toLiteUtc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const parseNum = (s?: string) => {
  const n = Number(String(s ?? '').replace(/[ ,]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const round = (x: number | null | undefined, places = 10) => {
  if (x == null || !Number.isFinite(x)) return null;
  const p = Math.pow(10, places);
  return Math.round(x * p) / p;
};
const parsePair = (input?: string) => {
  const raw = (input ?? '').toUpperCase().replace(/\s+/g, '').trim();
  if (!raw) return { base: '', quote: '' };
  const parts = raw.split(/[\/:-]/);
  if (parts.length >= 2) return { base: parts[0], quote: parts[1] };
  if (raw.endsWith('USDT')) return { base: raw.replace(/USDT$/, ''), quote: 'USDT' };
  return { base: raw, quote: 'USDT' };
};
const ensureFolder = async (app: App, path: string) => {
  if (app.vault.getAbstractFileByPath(path)) return;
  const parts = path.split('/');
  let accum = '';
  for (const part of parts) {
    accum = accum ? `${accum}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(accum)) await app.vault.createFolder(accum);
  }
};
const toUtcDateFromInput = (input: string | undefined, fallbackDate: Date | null = null) => {
  if (!input || !input.trim()) return fallbackDate;
  const s = input.trim().replace(/\s+UTC$/i, '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
  m = s.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? fallbackDate : d;
};
const isTradeFile = (f: TFile | null) => !!(f && f.basename?.startsWith('T-') && f.path?.includes('/Efforts/Ongoing/Trading/Trades/'));
class TradePicker extends SuggestModal<TFile> {
  files: TFile[];
  onChoose?: (f: TFile)=>void;
  constructor(app: App){ super(app); this.files = app.vault.getMarkdownFiles().filter(isTradeFile).sort((a,b)=> b.stat.mtime - a.stat.mtime).slice(0,50); }
  getSuggestions(query: string): TFile[] { const q = query.toLowerCase(); return this.files.filter(f => f.path.toLowerCase().includes(q)); }
  renderSuggestion(value: TFile, el: HTMLElement){ el.setText(value.path); }
  onChooseSuggestion(item: TFile) { this.onChoose?.(item); }
}
const pickTrade = async (app: App) => {
  const active = app.workspace.getActiveFile();
  if (isTradeFile(active)) return active;
  return await new Promise<TFile | null>(res => { const p = new TradePicker(app); p.onChoose = (f)=> res(f); p.open(); });
};
const expectedQuoteSign = (dir: number, side: Side) => (side === 'in' ? -dir : dir);
const buildFill = (opts: { dir: number; side: Side; amount: number; price?: number | null; quote?: number | null; when?: Date; note?: string; txs?: string[] }): Fill => {
  const { dir, side, amount } = opts;
  const when = opts.when ?? new Date();
  const baseAbs = Math.abs(Number(amount) || 0);
  const baseSign = dir * (side === 'in' ? 1 : -1);
  const base = round(baseSign * baseAbs) ?? 0;
  let quote = opts.quote != null ? Number(opts.quote) : null;
  let price = opts.price != null ? Number(opts.price) : null;
  if (price != null && price > 0) quote = round(-(base) * price);
  else if (quote != null && quote !== 0) price = round(Math.abs(quote) / Math.abs(base || 1));
  const fill: Fill = { side, t: toIsoUtc(when), base, quote: round(quote) ?? 0, price: round(price) ?? 0 };
  if (opts.note) fill.note = opts.note; if (opts.txs?.length) fill.txs = opts.txs;
  return fill;
};
const computeMetrics = (fm: Partial<TradeFrontmatter>): Metrics => {
  const fills = Array.isArray(fm?.fills) ? fm.fills as Fill[] : [];
  if (!fills.length) return { status: 'open', position: null, avg_entry: null, avg_exit: null, realized_pnl: null, r_multiple: null, win: null };
  let inB=0,inQ=0,outB=0,outQ=0; for (const f of fills){ const s=(f?.side||'in'); const b=Number(f?.base||0), q=Number(f?.quote||0); if (s==='in'){ inB+=b; inQ+=q; } else { outB+=b; outQ+=q; } }
  const abs=Math.abs; const avgEntry = inB ? abs(inQ)/abs(inB) : null; const avgExit = outB ? abs(outQ)/abs(outB) : null; const position = round(inB + outB);
  const exitedUnits = abs(outB); const realized = (exitedUnits && inB) ? round(abs(outQ) - (avgEntry! * exitedUnits)) : null;
  const status: Metrics['status'] = (position === 0 || !!fm.closed_at) ? 'closed' : 'open';
  let rMultiple: number | null = null; if (fm.initial_stop != null && avgEntry != null && exitedUnits){ const rpu = abs(avgEntry - Number(fm.initial_stop)); if (rpu>0) rMultiple = round((realized ?? 0) / (rpu*exitedUnits)); }
  const lastFillAt = fills.reduce((mx, f)=>{ const t = Date.parse(f.t || ''); return isNaN(t)?mx:Math.max(mx, t); }, 0);
  const win = realized != null ? realized > 0 : null;
  return { status, position: position ?? null, avg_entry: round(avgEntry), avg_exit: round(avgExit), realized_pnl: realized, r_multiple: rMultiple, win, last_fill_at: lastFillAt ? new Date(lastFillAt).toISOString() : null, computed_at: new Date().toISOString() };
};

class InputModal extends Modal {
  titleStr: string;
  fields: { id: string; label: string; placeholder?: string; default?: string }[];
  values: Record<string, string> = {};
  onSubmit: (vals: Record<string,string>) => void;
  constructor(app: App, title: string, fields: { id: string; label: string; placeholder?: string; default?: string }[], onSubmit: (vals: Record<string,string>) => void){
    super(app); this.titleStr = title; this.fields = fields; this.onSubmit = onSubmit;
  }
  onOpen(){ const { contentEl } = this; contentEl.empty(); contentEl.createEl('h3', { text: this.titleStr });
    this.fields.forEach(f => new Setting(contentEl).setName(f.label).addText(t => { if (f.placeholder) t.setPlaceholder(f.placeholder); if (f.default != null) t.setValue(String(f.default)); t.onChange(v => this.values[f.id] = v); }));
    new Setting(contentEl).addButton(b=>b.setButtonText('Cancel').onClick(()=>this.close())).addButton(b=>b.setCta().setButtonText('OK').onClick(()=>{ this.onSubmit(this.values); this.close(); }));
  }
  onClose(){ this.contentEl.empty(); }
}

class AceTradingSettingsTab extends PluginSettingTab {
  plugin: AceTradingPlugin;
  constructor(app: App, plugin: AceTradingPlugin){ super(app, plugin); this.plugin = plugin; }
  display(): void {
    const { containerEl } = this; containerEl.empty(); containerEl.createEl('h3', { text: 'ACE Trading Toolkit (TS) Settings' });
    new Setting(containerEl).setName('Trades Root Folder').setDesc('Base folder for trades; year subfolders created automatically').addText(t=> t.setValue(this.plugin.settings.tradesRoot).onChange(async(v)=>{ this.plugin.settings.tradesRoot=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Filename Pattern').setDesc('Vars: ${YYYY}${MM}${DD}${HH}${mm}, ${PAIR}, ${ACTION}').addText(t=> t.setValue(this.plugin.settings.filenamePattern).onChange(async(v)=>{ this.plugin.settings.filenamePattern=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Trade Body Template Path').setDesc('Path to Markdown template for note body; frontmatter is injected by plugin').addText(t=> t.setValue(this.plugin.settings.bodyTemplatePath).onChange(async(v)=>{ this.plugin.settings.bodyTemplatePath=v; await this.plugin.saveSettings(); }));
  }
}

export default class AceTradingPlugin extends Plugin {
  settings: AceTradingSettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new AceTradingSettingsTab(this.app, this));

    this.addCommand({ id: 'ace-new-trade', name: 'New Trade', callback: () => this.newTrade() });
    this.addCommand({ id: 'ace-add-fill', name: 'Add Trade Fill', callback: () => this.addFill() });
    this.addCommand({ id: 'ace-close-trade', name: 'Close Trade', callback: () => this.closeTrade() });
    this.addCommand({ id: 'ace-recompute-trade', name: 'Recompute Trade Metrics (current or pick)', callback: () => this.recomputeOne() });
    this.addCommand({ id: 'ace-bulk-recompute', name: 'Bulk Recompute Trade Metrics (folder/year)', callback: () => this.bulkRecompute() });
  }
  onunload() {}
  async saveSettings(){ await this.saveData(this.settings); }

  async newTrade() {
    const d = new Date();
    const defaults = { lite: `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC` };
    const fields = [
      { id:'pair', label:'Pair/Base (e.g., HYPE/USDT)' },
      { id:'action', label:'Action (long/short)', default:'long' },
      { id:'amount', label:'Amount (base units)' },
      { id:'allocation', label:'Allocation (quote spent, positive)' },
      { id:'account', label:'Account/Where' },
      { id:'initial_stop', label:'Initial stop (price, optional)' },
      { id:'timestamp', label:'Timestamp (UTC)', default: defaults.lite }
    ];
    new InputModal(this.app, 'New Trade', fields, async (vals)=>{
      try{
        const pairInput = vals.pair?.trim(); if (!pairInput) return;
        const { base: coinSym, quote: quoteSym } = parsePair(pairInput);
        const action = (vals.action||'long').toLowerCase() as Action; const dir = action==='short' ? -1 : 1;
        const amount = parseNum(vals.amount); const allocation = parseNum(vals.allocation);
        if (!Number.isFinite(amount) || amount <= 0) return new Notice('Amount must be > 0');
        if (!Number.isFinite(allocation) || allocation <= 0) return new Notice('Allocation must be > 0');
        const account = vals.account || '';
        const initial_stop = parseNum(vals.initial_stop);
        const tradeDate = toUtcDateFromInput(vals.timestamp || '', new Date())!;
        const yyyy = tradeDate.getUTCFullYear(), mm = pad(tradeDate.getUTCMonth()+1), dd = pad(tradeDate.getUTCDate()), hh = pad(tradeDate.getUTCHours()), mi = pad(tradeDate.getUTCMinutes());
        const datePart = `${yyyy}${mm}${dd}-${hh}${mi}`;
        const pairFlat = `${coinSym}${quoteSym}`;
        const fileBasePattern = this.settings.filenamePattern
          .replace('${YYYY}', String(yyyy))
          .replace('${MM}', String(mm))
          .replace('${DD}', String(dd))
          .replace('${HH}', String(hh))
          .replace('${mm}', String(mi))
          .replace('${PAIR}', pairFlat)
          .replace('${ACTION}', action);
        const id = fileBasePattern;
        const yearFolder = `${this.settings.tradesRoot}/${yyyy}`;
        await ensureFolder(this.app, this.settings.tradesRoot);
        await ensureFolder(this.app, yearFolder);
        let filePath = `${yearFolder}/${fileBasePattern}.md`;
        let suffix=1; while (this.app.vault.getAbstractFileByPath(filePath)) { filePath = `${yearFolder}/${fileBasePattern}-${suffix++}.md`; }
        const price = allocation/amount;
        const firstFill = buildFill({ dir, side: 'in', amount, price, when: tradeDate });
        const tsIso = toIsoUtc(tradeDate);
        const fmLines = [
          '---',
          `id: ${id}`,
          `schema_version: 2`,
          `timestamp: ${tsIso}`,
          `pair: ${coinSym}/${quoteSym}`,
          `action: ${action}`,
          `account: ${account}`,
          `quote: ${quoteSym}`,
          'fills:',
          `  - side: ${firstFill.side}`,
          `    t: ${firstFill.t}`,
          `    base: ${firstFill.base}`,
          `    quote: ${firstFill.quote}`,
          `    price: ${firstFill.price}`,
          '---'
        ];
        let body = '';
        try { body = await this.app.vault.adapter.read(this.settings.bodyTemplatePath); } catch {}
        if (!body) body = this.defaultBody();
        const content = `${fmLines.join('\n')}\n\n${body}`;
        const file = await this.app.vault.create(filePath, content);
        await this.persistMetrics(file);
        await this.app.workspace.getLeaf(true).openFile(file);
        new Notice(`Trade created: ${file.basename}`);
      }catch(e){ console.error(e); new Notice('Failed to create trade'); }
    }).open();
  }

  defaultBody(): string {
    return [
      '```button', 'name Add Fill', 'type command', 'action ACE Trading Toolkit (TS): Add Trade Fill', '```', '',
      '```button', 'name Close Trade', 'type command', 'action ACE Trading Toolkit (TS): Close Trade', '```', '',
      '```dataviewjs', 'await dv.view("utils/dataview/fills", { render: "metrics" })', '```', '',
      '# Fills', '', '```dataviewjs', 'await dv.view("utils/dataview/fills", { render: "fills" })', '```', '', '# Review', '-'
    ].join('\n');
  }

  async addFill(){
    const file = await pickTrade(this.app); if (!file) return;
    const page = this.app.metadataCache.getFileCache(file); const action = String(page?.frontmatter?.action || 'long').toLowerCase() as Action; const dir = action==='short'?-1:1;
    const fields = [
      { id:'side', label:'Side (in/out)', default:'in' },
      { id:'amount', label:'Amount (base units)' },
      { id:'quote', label:'Quote delta (spent<0>/received>0)' },
      { id:'time', label:'Time (UTC)', default: toLiteUtc(new Date()) },
      { id:'note', label:'Note (optional)' }
    ];
    new InputModal(this.app, 'Add Fill', fields, async (vals)=>{
      try{
        const side = (vals.side||'in').toLowerCase() as Side;
        const amt = parseNum(vals.amount); if (!Number.isFinite(amt) || amt<=0) return new Notice('Amount must be > 0');
        const q = parseNum(vals.quote); if (!Number.isFinite(q) || q === 0) return new Notice('Quote must be non-zero');
        const exp = expectedQuoteSign(dir, side); const quote = Math.abs(q) * exp; if (Math.sign(q) !== exp) new Notice(`Adjusted quote: ${q} -> ${quote}`);
        const when = toUtcDateFromInput(vals.time || '', new Date())!;
        const fill = buildFill({ dir, side, amount: amt, quote, when, note: vals.note||'' });
        await this.app.fileManager.processFrontMatter(file, (fm: any) => { if (!Array.isArray(fm.fills)) fm.fills = []; fm.fills.push(fill); });
        await this.persistMetrics(file);
        new Notice(`Added fill to ${file.basename}`);
      }catch(e){ console.error(e); new Notice('Failed to add fill'); }
    }).open();
  }

  async closeTrade(){
    const file = await pickTrade(this.app); if (!file) return;
    const page = this.app.metadataCache.getFileCache(file); const fm = page?.frontmatter as Partial<TradeFrontmatter> | undefined;
    const fills = Array.isArray(fm?.fills) ? fm!.fills! : [];
    const pos = fills.reduce((acc, f: any)=> acc + (Number(f.base)||0), 0);
    if (Math.abs(pos) < 1e-12) return new Notice('Already flat.');

    const action = String(fm?.action || 'long').toLowerCase() as Action; const dir = action==='short' ? -1 : 1;
    const fields = [
      { id:'mode', label:'Mode (price/quote)', default:'price' },
      { id:'price', label:'Exit price (quote/base, if mode=price)' },
      { id:'quote', label:'Exit quote delta (received>0/spent<0, if mode=quote)' },
      { id:'time', label:'Exit time (UTC)', default: toLiteUtc(new Date()) },
      { id:'note', label:'Note (optional)' }
    ];
    new InputModal(this.app, 'Close Trade', fields, async (vals)=>{
      try{
        const mode = (vals.mode||'price').toLowerCase();
        let price: number | null = null, quote: number | null = null;
        if (mode === 'price') { const p = parseNum(vals.price); if (!Number.isFinite(p) || p<=0) return new Notice('Price must be > 0'); price = p; }
        else { const q = parseNum(vals.quote); if (!Number.isFinite(q) || q===0) return new Notice('Quote must be non-zero'); const exp = expectedQuoteSign(dir, 'out'); quote = Math.abs(q) * exp; if (Math.sign(q)!==exp) new Notice(`Adjusted exit quote: ${q} -> ${quote}`); price = Math.abs(quote)/Math.abs(pos); }
        const when = toUtcDateFromInput(vals.time||'', new Date())!;
        const fill = buildFill({ dir, side:'out', amount: Math.abs(pos), price: price!, quote: quote!, when, note: vals.note||'' });
        await this.app.fileManager.processFrontMatter(file, (fw: any)=>{ if (!Array.isArray(fw.fills)) fw.fills = []; fw.fills.push(fill); fw.closed_at = toIsoUtc(when); });
        await this.persistMetrics(file);
        new Notice(`Closed ${file.basename} at ${Number(price).toFixed(6)}`);
      } catch(e){ console.error(e); new Notice('Failed to close trade'); }
    }).open();
  }

  async recomputeOne(){ const file = await pickTrade(this.app); if (!file) return; await this.persistMetrics(file); new Notice(`Recomputed metrics: ${file.basename}`); }

  async bulkRecompute(){
    const root = this.settings.tradesRoot; const def = `${root}/2025`;
    new InputModal(this.app, 'Bulk Recompute', [{ id:'folder', label:'Folder path', default: def }], async (vals)=>{
      const folder = (vals.folder||'').trim(); if (!folder) return;
      const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folder) && isTradeFile(f));
      let updated=0,total=0; for (const f of files){ total++; const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Partial<TradeFrontmatter>|undefined; if (fm?.schema_version!==2 || !Array.isArray(fm?.fills) || !fm?.fills?.length) continue; await this.persistMetrics(f); updated++; }
      new Notice(`Recomputed metrics: ${updated}/${total} in ${folder}`);
    }).open();
  }

  private async persistMetrics(file: TFile){
    await this.app.fileManager.processFrontMatter(file, (fw: any)=>{ const m = computeMetrics(fw); fw.metrics = m; });
  }
}

