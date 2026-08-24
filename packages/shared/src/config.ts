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

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
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
  // Partial book depth stream (see binance/client.ts); configurable window/cadence.
  binanceDepthStreamSuffix: envString("BINANCE_DEPTH_STREAM_SUFFIX", "depth20@100ms"),
  binanceReconnectBaseDelayMs: envInt("BINANCE_RECONNECT_BASE_DELAY_MS", 1000),
  binanceReconnectMaxDelayMs: envInt("BINANCE_RECONNECT_MAX_DELAY_MS", 30_000),

  // --- Binance metadata polling (REST) ---
  binanceRestBaseUrl: envString("BINANCE_REST_BASE_URL", "https://api.binance.com"),
  metaPollIntervalMs: envInt("META_POLL_INTERVAL_MS", 10_000),
  metaFetchTimeoutMs: envInt("META_FETCH_TIMEOUT_MS", 5000),

  // --- Redis (shared state between ingestion and broadcast processes) ---
  redisUrl: envString("REDIS_URL", "redis://localhost:6379"),

  // --- Process topology ---
  // "distributed" (default): broadcast reads from Redis, ingestion publishes to it.
  // "standalone": broadcast also runs ingestion in-process, no Redis — local-dev
  // fallback, set via .env.local (see loadEnv.ts). Not meant for production.
  appMode: envString("APP_MODE", "distributed") as "distributed" | "standalone",

  // --- Debugging ---
  // Verbose troubleshooting logs, off by default — see logger.ts and the :debug scripts.
  debug: envBool("DEBUG", false),
};
