// Kept as strings (Binance's own format) until point of use, to avoid float precision surprises.
export type BookLevel = [string, string]; // [price, quantity]

// Live, continuously-updated state for one trading pair — the source the broadcaster samples.
export interface PairState {
  pair: string; // e.g. "BTCUSDT"
  timestamp: number; // ms epoch of the last update applied
  price: number | null; // mid price (best bid + best ask) / 2
  spread: number | null; // best ask - best bid
  buyPressure: number | null; // 0-100, share of visible bid volume
  sellPressure: number | null; // 0-100, share of visible ask volume
  bids: BookLevel[]; // top N bids, best first
  asks: BookLevel[]; // top N asks, best first
  change24h: number | null; // % change, refreshed via periodic REST poll
  connected: boolean; // whether the upstream Binance stream for this pair is live
}

// Read-only view `Broadcaster` depends on; `MarketStore`/`RemoteMarketStore` both satisfy it.
export interface MarketReader {
  getAll(): PairState[];
  getPair(pair: string): PairState | undefined;
}

// Served by GET /pairs/meta. Never fabricated — see rest/pairsMeta.ts for the fallback.
export interface PairMeta {
  pair: string;
  tradingStatus: "TRADING" | "BREAK" | "UNKNOWN"; // UNKNOWN = no real data available yet
  high24h: number | null; // null when not available (never a fabricated value)
  low24h: number | null;
  volume24h: number | null;
  updatedAt: number | null; // ms epoch of the last successful Binance fetch, or null if never
}

// Outbound WebSocket message envelope. Kept as a small discriminated union
// so the mobile client can pattern-match on `type`.
export type ServerMessage =
  | { type: "snapshot"; data: PairState[] }
  | { type: "connection"; pair: string; connected: boolean };

export type WireFormat = "json" | "msgpack";

// Inbound control message — lets a client change cadence/encoding without reconnecting.
export type ClientMessage = {
  type: "configure";
  intervalMs?: number; // omit to leave interval unchanged
  format?: WireFormat; // omit to leave format unchanged
};
