import { config } from "../config";
import { TICKER_24HR_PATH } from "../constants/binance";
import { marketStore } from "../state/marketStore";
import { PairMeta } from "../types";

let latestMeta = new Map<string, PairMeta>();
// Surfaced via getMetaFetchError() instead of being silently swallowed.
let lastFetchError: string | null = null;

/**
 * Polls Binance's 24hr ticker once, feeding both the /pairs/meta cache and the
 * market store's change24h. Never fabricates data on failure — see README's
 * "No mock data" section for the fallback behavior.
 */
export async function refreshPairsMeta(): Promise<void> {
  try {
    const symbolsParam = encodeURIComponent(JSON.stringify(config.pairsUpper));
    const url = `${config.binanceRestBaseUrl}${TICKER_24HR_PATH}?symbols=${symbolsParam}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(config.metaFetchTimeoutMs) });
    if (!res.ok) throw new Error(`Binance responded ${res.status}`);
    const data = (await res.json()) as any[];
    const fetchedAt = Date.now();

    for (const d of data) {
      const pair = d.symbol as string;
      latestMeta.set(pair, {
        pair,
        tradingStatus: "TRADING",
        high24h: Number(d.highPrice),
        low24h: Number(d.lowPrice),
        volume24h: Number(d.volume),
        updatedAt: fetchedAt,
      });
      marketStore.applyChange24h(pair, Number(d.priceChangePercent));
    }

    if (lastFetchError) {
      console.log(`[meta] Binance 24hr fetch recovered (was failing: ${lastFetchError}).`);
    }
    lastFetchError = null;
  } catch (err) {
    lastFetchError = (err as Error).message;
    console.error(
      `[meta] Binance 24hr fetch failed: ${lastFetchError}.`,
      latestMeta.size > 0
        ? "Continuing to serve last known real values."
        : "No prior data available — /pairs/meta will report UNKNOWN until a fetch succeeds."
    );
    // Deliberately no fallback data write here — see function doc above.
  }
}

export function getPairsMeta(): PairMeta[] {
  if (latestMeta.size > 0) return Array.from(latestMeta.values());
  // Never fetched successfully yet: honest empty values, not invented ones.
  return config.pairsUpper.map((pair) => ({
    pair,
    tradingStatus: "UNKNOWN",
    high24h: null,
    low24h: null,
    volume24h: null,
    updatedAt: null,
  }));
}

/** Most recent Binance fetch error, if any, for callers that want to surface it. */
export function getMetaFetchError(): string | null {
  return lastFetchError;
}
