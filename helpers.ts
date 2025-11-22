import type { App, TFile } from 'obsidian';
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
const tzFormatters = new Map<string, Intl.DateTimeFormat>();
const getTimeZoneFormatter = (timeZone: string) => {
    const tz = timeZone || 'UTC';
    if (tzFormatters.has(tz)) return tzFormatters.get(tz)!;
    let formatter: Intl.DateTimeFormat;
    try {
        formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    } catch {
        formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'UTC',
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }
    tzFormatters.set(tz, formatter);
    return formatter;
};
const fallbackTimeZones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
export const getSystemTimeZone = () => {
    const formatter = Intl.DateTimeFormat();
    const opts = typeof formatter.resolvedOptions === 'function' ? formatter.resolvedOptions() : null;
    return opts?.timeZone || 'UTC';
};
export const getAvailableTimeZones = () => {
    const supported = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined;
    if (Array.isArray(supported) && supported.length) return supported;
    return fallbackTimeZones;
};
const extractParts = (input: string) => {
    const s = input.trim().replace(/\s+UTC$/i, '');
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) };
    m = s.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) };
    return null;
};
const buildUtcDateFromParts = (parts: { year: number; month: number; day: number; hour: number; minute: number }) => new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0));
const zonedPartsToUtc = (parts: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string) => {
    const candidate = buildUtcDateFromParts(parts);
    const formatter = getTimeZoneFormatter(timeZone);
    const zoned = formatter.formatToParts(candidate).reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});
    const zonedDate = new Date(Date.UTC(
        Number(zoned.year),
        Number(zoned.month) - 1,
        Number(zoned.day),
        Number(zoned.hour),
        Number(zoned.minute),
        Number(zoned.second || '0'),
    ));
    const diff = candidate.getTime() - zonedDate.getTime();
    return new Date(candidate.getTime() + diff);
};
export const formatDateTimeInZone = (date: Date, timeZone: string) => {
    const formatter = getTimeZoneFormatter(timeZone);
    const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});
    const year = parts.year ?? '0000';
    const month = parts.month ?? '01';
    const day = parts.day ?? '01';
    const hour = parts.hour ?? '00';
    const minute = parts.minute ?? '00';
    return `${year}-${month}-${day} ${hour}:${minute}`;
};
export const toUtcDateFromInput = (input: string | undefined, fallbackDate: Date | null = null, timeZone?: string) => {
    if (!input || !input.trim()) return fallbackDate;
    const trimmed = input.trim();
    const parts = extractParts(trimmed);
    if (parts) {
        if (timeZone && timeZone !== 'UTC') return zonedPartsToUtc(parts, timeZone);
        return buildUtcDateFromParts(parts);
    }
    const d = new Date(trimmed.replace(/\s+UTC$/i, ''));
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
        const directionalDiff = abs(outQ) - (avgEntryVal * exitedUnits);
        const dir = fm.action === 'short' ? -1 : fm.action === 'long' ? 1 : (inB < 0 ? -1 : 1);
        realized = round(dir * directionalDiff);
    }
    const status: Metrics['status'] = (position === 0 || !!fm.closed_at) ? 'closed' : 'open';
    let rMultiple: number | null = null; if (fm.initial_stop != null && avgEntry != null && exitedUnits) { const rpu = abs(avgEntry - Number(fm.initial_stop)); if (rpu > 0) rMultiple = round((realized ?? 0) / (rpu * exitedUnits)); }
    const lastFillAt = fills.reduce((mx, f) => { const t = Date.parse(f.t || ''); return isNaN(t) ? mx : Math.max(mx, t); }, 0);
    const win = realized != null ? realized > 0 : null;
    return { status, position: position ?? null, avg_entry: round(avgEntry), avg_exit: round(avgExit), realized_pnl: realized, r_multiple: rMultiple, win, last_fill_at: lastFillAt ? new Date(lastFillAt).toISOString() : null, computed_at: new Date().toISOString() };
};
