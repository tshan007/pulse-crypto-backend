function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

const pairsRaw = envString("PAIRS", "btcusdt,ethusdt,solusdt,dogeusdt,xrpusdt");

export const config = {
  // --- Server ---
  port: envInt("PORT", 8080),
  wsPath: envString("WS_PATH", "/ws"),

  // --- Broadcast ---
  broadcastIntervalMs: envInt("BROADCAST_INTERVAL_MS", 100),
  maxClientBufferedBytes: envInt("MAX_CLIENT_BUFFERED_BYTES", 1_048_576),

  // --- Tracked pairs ---
  // Lowercase symbols, as Binance expects them in stream names.
  pairsLower: pairsRaw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean),
  // Uppercase symbols, as used in our own payloads and REST responses.
  get pairsUpper() {
    return this.pairsLower.map((p: string) => p.toUpperCase());
  },
  depthLevels: envInt("DEPTH_LEVELS", 10), // bid/ask levels kept and broadcast per pair

  // --- Binance ingestion (WebSocket) ---
  binanceWsBaseUrl: envString("BINANCE_WS_BASE_URL", "wss://stream.binance.com:9443/stream"),
  // Partial book depth stream — see binance/client.ts for why this was chosen
  // over the raw diff-depth stream. Configurable so a smaller/larger depth
  // window or a different update cadence can be swapped without a code change.
  binanceDepthStreamSuffix: envString("BINANCE_DEPTH_STREAM_SUFFIX", "depth20@100ms"),
  binanceReconnectBaseDelayMs: envInt("BINANCE_RECONNECT_BASE_DELAY_MS", 1000),
  binanceReconnectMaxDelayMs: envInt("BINANCE_RECONNECT_MAX_DELAY_MS", 30_000),

  // --- Binance metadata polling (REST) ---
  binanceRestBaseUrl: envString("BINANCE_REST_BASE_URL", "https://api.binance.com"),
  metaPollIntervalMs: envInt("META_POLL_INTERVAL_MS", 10_000),
  metaFetchTimeoutMs: envInt("META_FETCH_TIMEOUT_MS", 5000),
};
