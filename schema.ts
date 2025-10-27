export type Action = 'long' | 'short';
export type Side = 'in' | 'out';

export interface Fill {
    side: Side;
    t: string; // ISO UTC
    base: number;
    quote: number;
    price: number;
    note?: string;
    txs?: string[];
}

export interface Metrics {
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

export interface TradeFrontmatter {
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