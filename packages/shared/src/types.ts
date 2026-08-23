// A single price/quantity level in the order book, as strings straight from
// Binance (we keep them as strings until the point of use to avoid float
// precision surprises, and only parse when computing derived numbers).
export type BookLevel = [string, string]; // [price, quantity]

// The live, continuously-updated state we hold in memory for one trading
// pair. This is the single source of truth the broadcaster samples from.
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

// Read-only view onto live market state. `MarketStore` (in-process) and the
// Redis-backed `RemoteMarketStore` (broadcast process, once ingestion runs
// separately) both satisfy this — it's what `Broadcaster` depends on instead
// of a concrete store, so the backing implementation can change without
// touching broadcast code.
export interface MarketReader {
  getAll(): PairState[];
  getPair(pair: string): PairState | undefined;
}

// Metadata for a pair, served by GET /pairs/meta. Sourced from Binance's
// 24hr ticker REST endpoint. Never fabricated — see rest/pairsMeta.ts for
// what happens when that source is unavailable.
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

// Inbound WebSocket control message. A client can send this at any point
// after connecting to change its own broadcast cadence and/or encoding
// without reconnecting. Always sent as JSON regardless of the negotiated
// data format — this channel is low-frequency and stays simple to debug.
export type ClientMessage = {
  type: "configure";
  intervalMs?: number; // omit to leave interval unchanged
  format?: WireFormat; // omit to leave format unchanged
};
