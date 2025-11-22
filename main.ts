import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	SuggestModal,
	TextComponent,
	stringifyYaml,
	WorkspaceLeaf,
} from 'obsidian';
import {
	pad,
	toIsoUtc,
	parseNum,
	parsePair,
	ensureFolder,
	toUtcDateFromInput,
	isTradeFile,
	buildFill,
	expectedQuoteSign,
	computeMetrics,
	formatDateTimeInZone,
	getAvailableTimeZones,
	getSystemTimeZone,
} from './helpers';
import { Action, Side, TradeFrontmatter, Fill } from './schema';
import { TradePaneView, VIEW_TYPE_TRADE, TradePaneCallbacks } from './trade-pane';

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

const pickFromModal = <T>(picker: SuggestModal<T>): Promise<T | null> =>
	new Promise<T | null>((resolve) => {
		let done = false;
		const finish = (value: T | null) => {
			if (done) return;
			done = true;
			resolve(value);
		};
		const origClose = picker.onClose.bind(picker);
		picker.onClose = () => {
			origClose();
			setTimeout(() => finish(null), 0);
		};
		(picker as SuggestModal<T> & { onChoose?: (value: T) => void }).onChoose = finish;
		picker.open();
	});

const pickTrade = async (app: App, rootPath: string) => {
	const active = app.workspace.getActiveFile();
	if (isTradeFile(active, rootPath)) return active;
	return await pickFromModal(new TradeFilePicker(app, { rootPath }))
};

const pickOpenTrade = async (app: App, rootPath: string) => {
	const active = app.workspace.getActiveFile();
	if (isTradeFile(active, rootPath)) return active;
	return await pickFromModal(new TradeFilePicker(app, { rootPath, filter: openTradesOnlyFilter(app) }))
};

const openTradesOnlyFilter = (app: App) => (file: TFile) => app.metadataCache.getFileCache(file)?.frontmatter?.closed_at === undefined;

type TradeFilePickerOptions = {
	rootPath?: string,
	filter?: (file: TFile) => boolean;
}

class TradeFilePicker extends SuggestModal<TFile> {
	files: TFile[];
	onChoose?: (f: TFile) => void;
	constructor(app: App, opts: TradeFilePickerOptions = {}) {
		super(app);
		const { rootPath, filter } = opts;

		const pass = filter ?? (() => true);
		this.files = app.vault
			.getMarkdownFiles()
			.filter(ff => isTradeFile(ff, rootPath))
			.filter(pass)
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}
	getSuggestions(query: string): TFile[] { const q = query.toLowerCase(); return this.files.filter(f => f.path.toLowerCase().includes(q)).slice(0, 200); }
	renderSuggestion(value: TFile, el: HTMLElement) { el.setText(value.path); }
	onChooseSuggestion(item: TFile) { this.onChoose?.(item); }
}


class FilePicker extends SuggestModal<TFile> {
	files: TFile[];
	onChoose?: (f: TFile) => void;
	constructor(app: App, rootPath?: string) { super(app); this.files = app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime); }
	getSuggestions(query: string): TFile[] { const q = query.toLowerCase(); return this.files.filter(f => f.path.toLowerCase().includes(q)).slice(0, 200); }
	renderSuggestion(value: TFile, el: HTMLElement) { el.setText(value.path); }
	onChooseSuggestion(item: TFile) { this.onChoose?.(item); }
}
class FolderPicker extends SuggestModal<TFolder> {
	folders: TFolder[];
	onChoose?: (f: TFolder) => void;
	constructor(app: App, rootPath?: string) {
		super(app);
		const all: TFolder[] = [];
		const walk = (folder: TFolder) => { all.push(folder); for (const c of folder.children) if (c instanceof TFolder) walk(c); };
		walk(app.vault.getRoot());
		const prefix = (rootPath || '').replace(/\/+$/, '');
		this.folders = all.filter(f => !prefix || f.path === prefix || f.path.startsWith(prefix + '/'));
		this.setPlaceholder('Select folder to recompute…');
	}
	getSuggestions(query: string): TFolder[] { const q = query.toLowerCase(); return this.folders.filter(f => f.path.toLowerCase().includes(q)); }
	renderSuggestion(value: TFolder, el: HTMLElement) { el.setText(value.path); }
	onChooseSuggestion(item: TFolder) { this.onChoose?.(item); }
}
type InputField = {
	id: string;
	label: string;
	placeholder?: string;
	default?: string;
	type?: 'text' | 'datetime';
	defaultTimezone?: string;
};

class InputModal extends Modal {
	titleStr: string;
	fields: InputField[];
	values: Record<string, string> = {};
	onSubmit: (vals: Record<string, string>) => void;
	private timeZones: string[];
	private systemTimeZone: string;
	constructor(app: App, title: string, fields: InputField[], onSubmit: (vals: Record<string, string>) => void) {
		super(app);
		this.titleStr = title;
		this.fields = fields;
		this.onSubmit = onSubmit;
		this.timeZones = getAvailableTimeZones();
		this.systemTimeZone = getSystemTimeZone();
	}
	onOpen() {
		const { contentEl } = this; contentEl.empty(); contentEl.createEl('h3', { text: this.titleStr });
		this.fields.forEach(f => {
			const setting = new Setting(contentEl).setName(f.label);
			const renderText = () => {
				setting.addText(t => {
					if (f.placeholder) t.setPlaceholder(f.placeholder);
					const initial = f.default != null ? String(f.default) : '';
					t.setValue(initial);
					this.values[f.id] = initial; // seed default so OK works without typing
					t.onChange(v => this.values[f.id] = v);
				});
			};
			if (f.type === 'datetime') {
				const tzDefault = f.defaultTimezone || this.systemTimeZone;
				this.values[`${f.id}_tz`] = tzDefault;
				renderText();
				setting.addDropdown(dropdown => {
					this.timeZones.forEach(zone => dropdown.addOption(zone, zone));
					dropdown.selectEl.title = `${f.label} timezone`;
					dropdown.selectEl.style.width = '220px';
					dropdown.setValue(tzDefault);
					dropdown.onChange(value => this.values[`${f.id}_tz`] = value);
				});
			} else {
				renderText();
			}
		});
		new Setting(contentEl)
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(b => b.setCta().setButtonText('OK').onClick(() => { this.onSubmit(this.values); this.close(); }));
	}
	onClose() { this.contentEl.empty(); }
}

class AceTradingSettingsTab extends PluginSettingTab {
	plugin: AceTradingPlugin;
	constructor(app: App, plugin: AceTradingPlugin) { super(app, plugin); this.plugin = plugin; }
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h3', { text: `${this.plugin.manifest.name} Settings` });

		const rootSetting = new Setting(containerEl)
			.setName('Trades Root Folder')
			.setDesc('Base folder for trades; year subfolders created automatically');
		let rootInput: TextComponent | null = null;
		rootSetting.addText(t => {
			rootInput = t;
			t.setPlaceholder('Select folder…');
			t.setValue(this.plugin.settings.tradesRoot);
			t.onChange(async (v) => {
				this.plugin.settings.tradesRoot = v;
				await this.plugin.saveSettings();
			});
		});
		rootSetting.addButton(btn => {
			btn.setButtonText('Select');
			btn.setTooltip('Choose a folder from the vault');
			btn.onClick(() => {
				const picker = new FolderPicker(this.app);
				picker.setPlaceholder('Select trades root folder…');
				picker.onChoose = async (folder: TFolder) => {
					const selectedPath = folder.path.replace(/\/+$/, '');
					if (!selectedPath) {
						new Notice('Please choose a non-root folder for trades.');
						return;
					}
					this.plugin.settings.tradesRoot = selectedPath;
					rootInput?.setValue(selectedPath);
					await this.plugin.saveSettings();
				};
				picker.open();
			});
		});

		new Setting(containerEl)
			.setName('Filename Pattern')
			.setDesc('Vars: ${YYYY}${MM}${DD}${HH}${mm}, ${PAIR}, ${ACTION}')
			.addText(t => t.setValue(this.plugin.settings.filenamePattern).onChange(async (v) => { this.plugin.settings.filenamePattern = v; await this.plugin.saveSettings(); }));

		const templateSetting = new Setting(containerEl)
			.setName('Trade Body Template Path')
			.setDesc('Path to Markdown template for note body; frontmatter is injected by plugin');
		let templateInput: TextComponent | null = null;
		templateSetting.addText(t => {
			templateInput = t;
			t.setPlaceholder('Select file…');
			t.setValue(this.plugin.settings.bodyTemplatePath);
			t.onChange(async (v) => {
				this.plugin.settings.bodyTemplatePath = v;
				await this.plugin.saveSettings();
			});
		});
		templateSetting.addButton(btn => {
			btn.setButtonText('Select');
			btn.setTooltip('Choose a Markdown file from the vault');
			btn.onClick(() => {
				const picker = new FilePicker(this.app);
				picker.setPlaceholder('Select trade template…');
				picker.onChoose = async (file: TFile) => {
					const selectedPath = file.path;
					this.plugin.settings.bodyTemplatePath = selectedPath;
					templateInput?.setValue(selectedPath);
					await this.plugin.saveSettings();
				};
				picker.open();
			});
		});
	}
}

export default class AceTradingPlugin extends Plugin {
	settings: AceTradingSettings;
	private lastTradeFile: TFile | null = null;

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.addSettingTab(new AceTradingSettingsTab(this.app, this));

		const callbacks: TradePaneCallbacks = {
			recompute: (file) => this.recomputeTrade(file, true),
			addFill: (file) => this.openAddFillModal(file),
			closeTrade: (file) => this.openCloseTradeModal(file),
		};

		this.registerView(
			VIEW_TYPE_TRADE,
			(leaf: WorkspaceLeaf) => new TradePaneView(leaf, callbacks)
		);

		this.addCommand({
			id: 'ace-open-trade-pane',
			name: 'Show Trade Pane',
			callback: () => this.activateTradePane(),
		});

		this.addCommand({ id: 'ace-new-trade', name: 'New Trade', callback: () => this.newTrade() });
		this.addCommand({ id: 'ace-add-fill', name: 'Add Trade Fill', callback: () => this.addFill() });
		this.addCommand({ id: 'ace-close-trade', name: 'Close Trade', callback: () => this.closeTrade() });
		this.addCommand({ id: 'ace-recompute-trade', name: 'Recompute Trade Metrics (current or pick)', callback: () => this.recomputeOne() });
		this.addCommand({ id: 'ace-bulk-recompute', name: 'Bulk Recompute Trade Metrics (folder/year)', callback: () => this.bulkRecompute() });

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.syncTradePane();
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				const leaf = this.getTradePaneLeaf(false);
				if (!leaf) return;
				const view = leaf.view;
				if (view instanceof TradePaneView && view.getFile()?.path === file.path) {
					this.lastTradeFile = file;
					view.setFile(file);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile)) return;
				const leaf = this.getTradePaneLeaf(false);
				if (!leaf) return;
				const view = leaf.view;
				if (view instanceof TradePaneView && view.getFile()?.path === file.path) {
					this.lastTradeFile = file;
					view.setFile(file);
				}
			})
		);

		this.app.workspace.onLayoutReady(() => {
			this.activateTradePane();
			this.syncTradePane();
		});
	}
	onunload() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_TRADE).forEach(leaf => this.app.workspace.detachLeavesOfType(VIEW_TYPE_TRADE));
	}
	async saveSettings() { await this.saveData(this.settings); }

	private getTradePaneLeaf(create: boolean): WorkspaceLeaf | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TRADE);
		if (leaves.length > 0) return leaves[0];
		if (!create) return null;
		return this.app.workspace.getRightLeaf(false);
	}

	private async activateTradePane(): Promise<void> {
		let leaf = this.getTradePaneLeaf(false);
		if (!leaf) {
			leaf = this.getTradePaneLeaf(true);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_TRADE, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	private syncTradePane(force = false): void {
		const leaf = this.getTradePaneLeaf(false);
		if (!leaf) return;
		const view = leaf.view;
		if (!(view instanceof TradePaneView)) return;

		const activeFile = this.app.workspace.getActiveFile();
		const current = view.getFile();
		if (activeFile && isTradeFile(activeFile, this.settings.tradesRoot)) {
			this.lastTradeFile = activeFile;
			if (force) {
				if (!current || current.path !== activeFile.path) view.setFile(activeFile);
				else view.refresh();
			} else if (!current || current.path !== activeFile.path) {
				view.setFile(activeFile);
			}
			return;
		}

		if (activeFile && !isTradeFile(activeFile, this.settings.tradesRoot)) {
			this.lastTradeFile = null;
			if (current) view.setFile(null);
			return;
		}

		if (this.lastTradeFile) {
			if (force) {
				if (!current || current.path !== this.lastTradeFile.path) view.setFile(this.lastTradeFile);
				else view.refresh();
			} else if (!current || current.path !== this.lastTradeFile.path) {
				view.setFile(this.lastTradeFile);
			}
			return;
		}

		if (current) view.setFile(null);
	}

	private refreshTradePane(): void {
		this.syncTradePane(true);
	}

	async newTrade() {
		const d = new Date();
		const systemTimeZone = getSystemTimeZone();
		const defaults = { lite: formatDateTimeInZone(d, systemTimeZone) };
		const fields: InputField[] = [
			{ id: 'pair', label: 'Pair/Base (e.g., HYPE/USDT)' },
			{ id: 'action', label: 'Action (long/short)', default: 'long' },
			{ id: 'amount', label: 'Amount (base units)' },
			{ id: 'allocation', label: 'Allocation (quote spent, positive)' },
			{ id: 'tags', label: 'Tags, comma or space separated' },
			{ id: 'account', label: 'Account/Where' },
			{ id: 'initial_stop', label: 'Initial stop (price, optional)' },
			{ id: 'timestamp', label: 'Timestamp', default: defaults.lite, type: 'datetime', defaultTimezone: systemTimeZone }
		];
		new InputModal(this.app, 'New Trade', fields, async (vals) => {
			try {
				const pairInput = vals.pair?.trim(); if (!pairInput) return;
				const { base: coinSym, quote: quoteSym } = parsePair(pairInput);
				const action = (vals.action || 'long').toLowerCase() as Action; const dir = action === 'short' ? -1 : 1;
				const amount = parseNum(vals.amount); const allocation = parseNum(vals.allocation);
				if (!Number.isFinite(amount) || amount <= 0) return new Notice('Amount must be > 0');
				if (!Number.isFinite(allocation) || allocation <= 0) return new Notice('Allocation must be > 0');
				const account = (vals.account || '').trim();
				const initialStop = parseNum(vals.initial_stop);
				const tags: string[] = (vals.tags || '')
					.split(/[\s,]+/)
					.map(tag => tag.replace(/^#/, '').trim())
					.filter(Boolean);
				const tradeDate = toUtcDateFromInput(vals.timestamp || '', new Date(), vals['timestamp_tz'])!;
				const yyyy = tradeDate.getUTCFullYear(), mm = pad(tradeDate.getUTCMonth() + 1), dd = pad(tradeDate.getUTCDate()), hh = pad(tradeDate.getUTCHours()), mi = pad(tradeDate.getUTCMinutes());
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
				let suffix = 1; while (this.app.vault.getAbstractFileByPath(filePath)) { filePath = `${yearFolder}/${fileBasePattern}-${suffix++}.md`; }
				const price = allocation / amount;
				const firstFill: Fill = buildFill({ dir, side: 'in', amount, price, when: tradeDate });
				const tsIso = toIsoUtc(tradeDate);
				const frontmatter: TradeFrontmatter = {
					id,
					schema_version: 2,
					timestamp: tsIso,
					pair: `${coinSym}/${quoteSym}`,
					action,
					lesson: '',
					tags,
					quote: quoteSym,
					fills: [firstFill],
				};
				if (account) frontmatter.account = account;
				if (Number.isFinite(initialStop)) frontmatter.initial_stop = initialStop;

				let body = '';
				try {
					body = await this.app.vault.adapter.read(this.settings.bodyTemplatePath);
				} catch {
					new Notice(`Couldn't find trade template at ${this.settings.bodyTemplatePath}`, 0);
				}
				const content = `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
				const file = await this.app.vault.create(filePath, content);
				await this.persistMetrics(file);
				await this.app.workspace.getLeaf(true).openFile(file);
				new Notice(`Trade created: ${file.basename}`);
			} catch (e) { console.error(e); new Notice('Failed to create trade'); }
		}).open();
	}

	async addFill() {
		const file = await pickOpenTrade(this.app, this.settings.tradesRoot);
		if (!file) return;
		this.openAddFillModal(file);
	}

	async closeTrade() {
		const file = await pickOpenTrade(this.app, this.settings.tradesRoot); if (!file) return;
		this.openCloseTradeModal(file);
	}

	async recomputeOne() { const file = await pickTrade(this.app, this.settings.tradesRoot); if (!file) return; await this.recomputeTrade(file, true); }

	async bulkRecompute() {
		const root = this.settings.tradesRoot; const year = new Date().getUTCFullYear(); const def = `${root}/${year}`;
		const picker = new FolderPicker(this.app, root);
		picker.onChoose = async (folder: TFolder) => {
			const folderPath = folder?.path || def;
			const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folderPath) && f.basename.startsWith('T-'));
			let updated = 0, total = 0; for (const f of files) { total++; const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Partial<TradeFrontmatter> | undefined; if (fm?.schema_version !== 2 || !Array.isArray(fm?.fills) || !fm?.fills?.length) continue; await this.recomputeTrade(f, false); updated++; }
			new Notice(`Recomputed metrics: ${updated}/${total} in ${folderPath}`);
		};
		picker.open();
	}

	private openAddFillModal(file: TFile): void {
		const page = this.app.metadataCache.getFileCache(file);
		const fm = page?.frontmatter as Partial<TradeFrontmatter> | undefined;
		if (fm?.closed_at) {
			new Notice('Trade is already closed.');
			return;
		}
		const action = String(fm?.action || 'long').toLowerCase() as Action;
		const dir = action === 'short' ? -1 : 1;
		const systemTimeZone = getSystemTimeZone();
		const defaultTime = formatDateTimeInZone(new Date(), systemTimeZone);
		const fields: InputField[] = [
			{ id: 'side', label: 'Side (in/out)', default: 'in' },
			{ id: 'amount', label: 'Amount (base units)' },
			{ id: 'quote', label: 'Quote delta (spent<0>/received>0)' },
			{ id: 'time', label: 'Time', default: defaultTime, type: 'datetime', defaultTimezone: systemTimeZone },
			{ id: 'note', label: 'Note (optional)' }
		];
		new InputModal(this.app, 'Add Fill', fields, async (vals) => {
			try {
				const side = (vals.side || 'in').toLowerCase() as Side;
				const amt = parseNum(vals.amount); if (!Number.isFinite(amt) || amt <= 0) return new Notice('Amount must be > 0');
				const q = parseNum(vals.quote); if (!Number.isFinite(q) || q === 0) return new Notice('Quote must be non-zero');
				const exp = expectedQuoteSign(dir, side); const quote = Math.abs(q) * exp; if (Math.sign(q) !== exp) new Notice(`Adjusted quote: ${q} -> ${quote}`);
				const when = toUtcDateFromInput(vals.time || '', new Date(), vals['time_tz'])!;
				const fill = buildFill({ dir, side, amount: amt, quote, when, note: vals.note || '' });
				await this.app.fileManager.processFrontMatter(file, (frontmatter: any) => { if (!Array.isArray(frontmatter.fills)) frontmatter.fills = []; frontmatter.fills.push(fill); });
				await this.persistMetrics(file);
				this.refreshTradePane();
				new Notice(`Added fill to ${file.basename}`);
			} catch (e) { console.error(e); new Notice('Failed to add fill'); }
		}).open();
	}

	private openCloseTradeModal(file: TFile): void {
		const page = this.app.metadataCache.getFileCache(file); const fm = page?.frontmatter as Partial<TradeFrontmatter> | undefined;
		const fills = Array.isArray(fm?.fills) ? fm!.fills! : [];
		const pos = fills.reduce((acc, f: any) => acc + (Number(f.base) || 0), 0);
		if (Math.abs(pos) < 1e-12) { new Notice('Already flat.'); return; }

		const action = String(fm?.action || 'long').toLowerCase() as Action; const dir = action === 'short' ? -1 : 1;
		const systemTimeZone = getSystemTimeZone();
		const defaultExitTime = formatDateTimeInZone(new Date(), systemTimeZone);
		const fields: InputField[] = [
			{ id: 'mode', label: 'Mode (price/quote)', default: 'price' },
			{ id: 'price', label: 'Exit price (quote/base, if mode=price)' },
			{ id: 'quote', label: 'Exit quote delta (received>0/spent<0, if mode=quote)' },
			{ id: 'time', label: 'Exit time', default: defaultExitTime, type: 'datetime', defaultTimezone: systemTimeZone },
			{ id: 'note', label: 'Note (optional)' }
		];
		new InputModal(this.app, 'Close Trade', fields, async (vals) => {
			try {
				const mode = (vals.mode || 'price').toLowerCase();
				const when = toUtcDateFromInput(vals.time || '', new Date(), vals['time_tz'])!;
				if (mode === 'price') {
					const p = parseNum(vals.price); if (!Number.isFinite(p) || p <= 0) return new Notice('Price must be > 0');
					const fill = buildFill({ dir, side: 'out', amount: Math.abs(pos), price: p, when, note: vals.note || '' });
					await this.app.fileManager.processFrontMatter(file, (fw: any) => { if (!Array.isArray(fw.fills)) fw.fills = []; fw.fills.push(fill); fw.closed_at = toIsoUtc(when); });
				} else {
					const q = parseNum(vals.quote); if (!Number.isFinite(q) || q === 0) return new Notice('Quote must be non-zero');
					const exp = expectedQuoteSign(dir, 'out'); const adjusted = Math.abs(q) * exp; if (Math.sign(q) !== exp) new Notice(`Adjusted exit quote: ${q} -> ${adjusted}`);
					const fill = buildFill({ dir, side: 'out', amount: Math.abs(pos), quote: adjusted, when, note: vals.note || '' });
					await this.app.fileManager.processFrontMatter(file, (fw: any) => { if (!Array.isArray(fw.fills)) fw.fills = []; fw.fills.push(fill); fw.closed_at = toIsoUtc(when); });
				}
				await this.persistMetrics(file);
				this.refreshTradePane();
				new Notice(`Closed ${file.basename}`);
			} catch (e) { console.error(e); new Notice('Failed to close trade'); }
		}).open();
	}

	private async recomputeTrade(file: TFile, notify: boolean): Promise<void> {
		await this.persistMetrics(file);
		if (notify) new Notice(`Recomputed metrics: ${file.basename}`);
		this.refreshTradePane();
	}

	private async persistMetrics(file: TFile) {
		await this.app.fileManager.processFrontMatter(file, (fw: any) => { const m = computeMetrics(fw); fw.metrics = m; });
	}
}
