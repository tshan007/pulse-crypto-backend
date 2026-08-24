export const MARKET_UPDATES_CHANNEL = "market:updates";
export const PAIRS_META_CACHE_KEY = "pairsmeta:cache";
export const PAIRS_META_FETCH_ERROR_KEY = "pairsmeta:fetcherror";

export function marketKey(pair: string): string {
  return `market:${pair}`;
}
