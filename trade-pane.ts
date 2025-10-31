import type { TFile } from 'obsidian';
import { ItemView, WorkspaceLeaf, ButtonComponent } from 'obsidian';
import type { TradeFrontmatter, Fill } from './schema';
import { computeMetrics } from './helpers';

export const VIEW_TYPE_TRADE = 'ace-trade-pane';

export interface TradePaneCallbacks {
	recompute(file: TFile): Promise<void>;
	addFill(file: TFile): void;
	closeTrade(file: TFile): void;
}

export class TradePaneView extends ItemView {
	private currentFile: TFile | null = null;
	private scrollContainer: HTMLElement | null = null;
	private readonly callbacks: TradePaneCallbacks;

	constructor(leaf: WorkspaceLeaf, callbacks: TradePaneCallbacks) {
		super(leaf);
		this.callbacks = callbacks;
	}

	getViewType(): string {
		return VIEW_TYPE_TRADE;
	}

	getDisplayText(): string {
		return 'Trade';
	}

	getIcon(): string {
		return 'line-chart';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl;
		container.empty();
		container.addClass('ace-trade-pane');
		this.scrollContainer = container.createDiv({ cls: 'ace-trade-pane-body' });
		this.render();
	}

	async onClose(): Promise<void> {
		/* no-op */
	}

	setFile(file: TFile | null): void {
		if (this.currentFile?.path === file?.path) {
			this.render();
			return;
		}
		this.currentFile = file;
		this.render();
	}

	getFile(): TFile | null {
		return this.currentFile;
	}

	refresh(): void {
		this.render();
	}

	private render(): void {
		const container = this.scrollContainer ?? this.containerEl;
		container.empty();

		const header = container.createDiv({ cls: 'ace-trade-pane-header' });
		header.createEl('h2', { text: 'Trade Overview' });

		if (!this.currentFile) {
			container.createSpan({ text: 'Open a trade note to see metrics.' });
			return;
		}

		const fm = this.getFrontmatter();
		if (!fm) {
			container.createSpan({ text: 'Unable to read trade frontmatter.' });
			return;
		}

		const metrics = computeMetrics(fm);
		this.renderMetrics(container, fm, metrics);
		this.renderFills(container, fm);
		this.renderActions(container);
	}

	private renderMetrics(el: HTMLElement, fm: Partial<TradeFrontmatter>, metrics: ReturnType<typeof computeMetrics>): void {
		const section = el.createDiv({ cls: 'ace-trade-pane-section' });
		section.createEl('h3', { text: 'Metrics' });

		const table = section.createEl('table', { cls: 'ace-trade-metrics' });
		const tbody = table.createEl('tbody');

		const rows: Array<[string, string | number | null | undefined]> = [
			['Status', metrics.status],
			['Pair', fm.pair],
			['Action', fm.action],
			['Position', metrics.position?.toString()],
			['Avg Entry', metrics.avg_entry?.toString()],
			['Avg Exit', metrics.avg_exit?.toString()],
			['Realized PnL', metrics.realized_pnl?.toString()],
			['R Multiple', metrics.r_multiple?.toString()],
			['Last Fill', metrics.last_fill_at],
			['Computed', metrics.computed_at],
		];

		for (const [label, value] of rows) {
			const tr = tbody.createEl('tr');
			tr.createEl('th', { text: label });
			tr.createEl('td', { text: value != null ? String(value) : '—' });
		}
	}

	private renderFills(el: HTMLElement, fm: Partial<TradeFrontmatter>): void {
		const section = el.createDiv({ cls: 'ace-trade-pane-section' });
		section.createEl('h3', { text: 'Fills' });

		const fills = Array.isArray(fm.fills) ? fm.fills : [];
		if (!fills.length) {
			section.createSpan({ text: 'No fills recorded.' });
			return;
		}

		const table = section.createEl('table', { cls: 'ace-trade-fills' });
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		['Time (UTC)', 'Side', 'Base', 'Quote', 'Price', 'Note'].forEach((heading) => headerRow.createEl('th', { text: heading }));

		const tbody = table.createEl('tbody');
		for (const fill of fills as Fill[]) {
			const tr = tbody.createEl('tr');
			const time = fill.t ? new Date(fill.t).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '';
			const values: Array<string | number | null | undefined> = [time, fill.side, fill.base, fill.quote, fill.price, fill.note || ''];
			for (const value of values) {
				tr.createEl('td', { text: value != null ? String(value) : '' });
			}
		}
	}

	private renderActions(el: HTMLElement): void {
		const section = el.createDiv({ cls: 'ace-trade-pane-section ace-trade-pane-actions' });
		const current = this.currentFile;
		const disabled = !current;

		const recompute = new ButtonComponent(section);
		recompute.setButtonText('Recompute Metrics');
		recompute.setDisabled(disabled);
		recompute.onClick(async () => {
			const file = this.currentFile;
			if (!file) return;
			await this.callbacks.recompute(file);
		});

		const addFill = new ButtonComponent(section);
		addFill.setButtonText('Add Fill');
		addFill.setDisabled(disabled);
		addFill.onClick(() => {
			const file = this.currentFile;
			if (!file) return;
			this.callbacks.addFill(file);
		});

		const closeTrade = new ButtonComponent(section);
		closeTrade.setButtonText('Close Trade');
		closeTrade.setDisabled(disabled);
		closeTrade.onClick(() => {
			const file = this.currentFile;
			if (!file) return;
			this.callbacks.closeTrade(file);
		});
	}

	private getFrontmatter(): Partial<TradeFrontmatter> | null {
		const file = this.currentFile;
		if (!file) return null;
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter as Partial<TradeFrontmatter> | undefined;
		return fm ?? null;
	}
}
