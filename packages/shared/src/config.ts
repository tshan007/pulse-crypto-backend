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

  // --- Redis (shared state between ingestion and broadcast processes) ---
  redisUrl: envString("REDIS_URL", "redis://localhost:6379"),

  // --- Process topology ---
  // "distributed" (default): index.ts is broadcast-only and reads market/meta state
  // from Redis, published by a separately-run ingestion.ts — see docker-compose.yml.
  // "standalone": index.ts also runs the Binance ingestion in-process, no Redis
  // involved at all. Local-dev fallback for anyone without Docker/Redis available;
  // not meant for production (no split, no horizontal scaling of broadcast). Set by
  // .env.local (via the dev:broadcast:local script alias), not meant to be passed
  // directly — see loadEnv.ts.
  appMode: envString("APP_MODE", "distributed") as "distributed" | "standalone",

  // --- Debugging ---
  // Verbose, high-volume logging for troubleshooting (connection lifecycle, every
  // Redis publish/subscribe, per-client configure/backpressure events, resolved
  // config at startup). Off by default — see the :debug script aliases in
  // package.json and src/logger.ts.
  debug: envBool("DEBUG", false),
};
