import { config } from "../config";
import { marketStore } from "../state/marketStore";
import { PairMeta } from "../types";

let latestMeta = new Map<string, PairMeta>();
// Tracks the most recent fetch failure so it can be surfaced to callers
// (logged, and exposed via getMetaFetchError() for the REST layer) instead
// of being silently papered over with invented numbers.
let lastFetchError: string | null = null;

/**
 * Polls Binance's 24hr ticker REST endpoint once, and feeds the result into
 * both the /pairs/meta cache and the live market store's change24h field.
 * One HTTP call serves both purposes rather than duplicating the request.
 *
 * Fallback behavior on failure (rate limiting, network issue, geo-blocking):
 * we deliberately do NOT fabricate mock numbers. Instead:
 *   - If a previous successful fetch exists, that cached real data keeps
 *     being served (stale-but-real beats fake-but-fresh) and change24h in
 *     the market store is simply left untouched.
 *   - If there has never been a successful fetch, getPairsMeta() returns
 *     each pair with null high/low/volume and tradingStatus "UNKNOWN" —
 *     an honest "we don't know yet" rather than invented figures — and
 *     change24h in the market store stays at its default (null).
 * The failure itself is always logged, and the most recent error message
 * is available via getMetaFetchError() for callers that want to surface it
 * (e.g. as a response header — see index.ts).
 */
export async function refreshPairsMeta(): Promise<void> {
  try {
    const symbolsParam = encodeURIComponent(JSON.stringify(config.pairsUpper));
    const url = `${config.binanceRestBaseUrl}/api/v3/ticker/24hr?symbols=${symbolsParam}`;
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
