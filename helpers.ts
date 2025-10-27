import { App, TFile } from 'obsidian';
import { Metrics, Fill, Side, TradeFrontmatter } from './schema';
// Helpers
export const pad = (n: number) => String(n).padStart(2, '0');
export const toIsoUtc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00.000Z`;
export const toLiteUtc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
export const parseNum = (s?: string) => {
    const n = Number(String(s ?? '').replace(/[ ,]/g, ''));
    return Number.isFinite(n) ? n : NaN;
};
export const round = (x: number | null | undefined, places = 10) => {
    if (x == null || !Number.isFinite(x)) return null;
    const p = Math.pow(10, places);
    return Math.round(x * p) / p;
};
export const parsePair = (input?: string) => {
    const raw = (input ?? '').toUpperCase().replace(/\s+/g, '').trim();
    if (!raw) return { base: '', quote: '' };
    const parts = raw.split(/[/:-]/);
    if (parts.length >= 2) return { base: parts[0], quote: parts[1] };
    if (raw.endsWith('USDT')) return { base: raw.replace(/USDT$/, ''), quote: 'USDT' };
    return { base: raw, quote: 'USDT' };
};
export const ensureFolder = async (app: App, path: string) => {
    if (app.vault.getAbstractFileByPath(path)) return;
    const parts = path.split('/');
    let accum = '';
    for (const part of parts) {
        accum = accum ? `${accum}/${part}` : part;
        if (!app.vault.getAbstractFileByPath(accum)) await app.vault.createFolder(accum);
    }
};
export const toUtcDateFromInput = (input: string | undefined, fallbackDate: Date | null = null) => {
    if (!input || !input.trim()) return fallbackDate;
    const s = input.trim().replace(/\s+UTC$/i, '');
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
    m = s.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
    const d = new Date(s);
    return isNaN(d.getTime()) ? fallbackDate : d;
};
export const isTradeFile = (f: TFile | null, root?: string) => !!(f && f.basename?.startsWith('T-') && (!root || (f.path && f.path.startsWith(root + '/'))));


export const expectedQuoteSign = (dir: number, side: Side) => (side === 'in' ? -dir : dir);
export const buildFill = (opts: { dir: number; side: Side; amount: number; price?: number | null; quote?: number | null; when?: Date; note?: string; txs?: string[] }): Fill => {
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
export const computeMetrics = (fm: Partial<TradeFrontmatter>): Metrics => {
    const fills = Array.isArray(fm?.fills) ? fm.fills as Fill[] : [];
    if (!fills.length) return { status: 'open', position: null, avg_entry: null, avg_exit: null, realized_pnl: null, r_multiple: null, win: null };
    let inB = 0, inQ = 0, outB = 0, outQ = 0; for (const f of fills) { const s = (f?.side || 'in'); const b = Number(f?.base || 0), q = Number(f?.quote || 0); if (s === 'in') { inB += b; inQ += q; } else { outB += b; outQ += q; } }
    const abs = Math.abs; const avgEntry = inB ? abs(inQ) / abs(inB) : null; const avgExit = outB ? abs(outQ) / abs(outB) : null; const position = round(inB + outB);
    const exitedUnits = abs(outB);
    let realized: number | null = null;
    if (exitedUnits && inB) {
        const avgEntryVal = avgEntry as number;
        realized = round(abs(outQ) - (avgEntryVal * exitedUnits));
    }
    const status: Metrics['status'] = (position === 0 || !!fm.closed_at) ? 'closed' : 'open';
    let rMultiple: number | null = null; if (fm.initial_stop != null && avgEntry != null && exitedUnits) { const rpu = abs(avgEntry - Number(fm.initial_stop)); if (rpu > 0) rMultiple = round((realized ?? 0) / (rpu * exitedUnits)); }
    const lastFillAt = fills.reduce((mx, f) => { const t = Date.parse(f.t || ''); return isNaN(t) ? mx : Math.max(mx, t); }, 0);
    const win = realized != null ? realized > 0 : null;
    return { status, position: position ?? null, avg_entry: round(avgEntry), avg_exit: round(avgExit), realized_pnl: realized, r_multiple: rMultiple, win, last_fill_at: lastFillAt ? new Date(lastFillAt).toISOString() : null, computed_at: new Date().toISOString() };
};