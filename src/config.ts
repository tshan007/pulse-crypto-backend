function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true";
}

const pairsRaw = process.env.PAIRS ?? "btcusdt,ethusdt,solusdt,dogeusdt,xrpusdt";

export const config = {
  port: envInt("PORT", 8080),
  broadcastIntervalMs: envInt("BROADCAST_INTERVAL_MS", 100),
  metaPollIntervalMs: envInt("META_POLL_INTERVAL_MS", 10_000),
  maxClientBufferedBytes: envInt("MAX_CLIENT_BUFFERED_BYTES", 1_048_576),
  allowMockMeta: envBool("ALLOW_MOCK_META", true),
  // Lowercase symbols, as Binance expects them in stream names.
  pairsLower: pairsRaw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean),
  // Uppercase symbols, as used in our own payloads and REST responses.
  get pairsUpper() {
    return this.pairsLower.map((p: string) => p.toUpperCase());
  },
  depthLevels: 10, // how many bid/ask levels we keep and broadcast per pair
};
