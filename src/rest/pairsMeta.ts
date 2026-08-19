import { config } from "../config";
import { marketStore } from "../state/marketStore";
import { PairMeta } from "../types";

const DISPLAY_NAMES: Record<string, string> = {
  BTCUSDT: "Bitcoin / Tether",
  ETHUSDT: "Ethereum / Tether",
  SOLUSDT: "Solana / Tether",
  DOGEUSDT: "Dogecoin / Tether",
  XRPUSDT: "XRP / Tether",
};

// Static fallback used only if the Binance REST call fails (offline dev, no
// network egress, rate limiting, etc). Keeps /pairs/meta always available,
// per the assignment's "this data may be mocked" allowance.
const MOCK_META: Record<string, { high24h: number; low24h: number; volume24h: number; change24h: number }> = {
  BTCUSDT: { high24h: 111200, low24h: 106800, volume24h: 18234.5, change24h: 1.82 },
  ETHUSDT: { high24h: 3480, low24h: 3210, volume24h: 152300.1, change24h: -0.41 },
  SOLUSDT: { high24h: 198.5, low24h: 178.2, volume24h: 890231.4, change24h: 4.12 },
  DOGEUSDT: { high24h: 0.219, low24h: 0.198, volume24h: 4123456.7, change24h: 0.83 },
  XRPUSDT: { high24h: 3.12, low24h: 2.85, volume24h: 2231456.9, change24h: -1.22 },
};

let latestMeta = new Map<string, PairMeta>();

function applyMockFallback() {
  for (const pair of config.pairsUpper) {
    const mock = MOCK_META[pair];
    latestMeta.set(pair, {
      pair,
      displayName: DISPLAY_NAMES[pair] ?? pair,
      tradingStatus: "TRADING",
      high24h: mock?.high24h ?? null,
      low24h: mock?.low24h ?? null,
      volume24h: mock?.volume24h ?? null,
    });
    marketStore.applyChange24h(pair, mock?.change24h ?? 0);
  }
}

/**
 * Polls Binance's 24hr ticker REST endpoint once, and feeds the result into
 * both the /pairs/meta cache and the live market store's change24h field.
 * One HTTP call serves both purposes rather than duplicating the request.
 */
export async function refreshPairsMeta(): Promise<void> {
  try {
    const symbolsParam = encodeURIComponent(JSON.stringify(config.pairsUpper));
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${symbolsParam}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Binance responded ${res.status}`);
    const data = (await res.json()) as any[];

    for (const d of data) {
      const pair = d.symbol as string;
      latestMeta.set(pair, {
        pair,
        displayName: DISPLAY_NAMES[pair] ?? pair,
        tradingStatus: "TRADING",
        high24h: Number(d.highPrice),
        low24h: Number(d.lowPrice),
        volume24h: Number(d.volume),
      });
      marketStore.applyChange24h(pair, Number(d.priceChangePercent));
    }
  } catch (err) {
    console.error("[meta] Binance 24hr fetch failed, falling back to mock data:", (err as Error).message);
    if (config.allowMockMeta) applyMockFallback();
  }
}

export function getPairsMeta(): PairMeta[] {
  if (latestMeta.size > 0) return Array.from(latestMeta.values());
  // Nothing fetched yet (e.g. called before first poll completes).
  return config.pairsUpper.map((pair) => ({
    pair,
    displayName: DISPLAY_NAMES[pair] ?? pair,
    tradingStatus: "UNKNOWN",
    high24h: null,
    low24h: null,
    volume24h: null,
  }));
}
