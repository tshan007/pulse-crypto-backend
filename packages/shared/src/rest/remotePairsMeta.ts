import Redis from "ioredis";
import { config } from "../config";
import { PAIRS_META_CACHE_KEY, PAIRS_META_FETCH_ERROR_KEY } from "../constants/redisKeys";
import { PairMeta } from "../types";

/** Broadcast-side counterpart to `pairsMeta.ts`; reads straight off Redis (low-frequency route, no local cache needed). */
export async function getRemotePairsMeta(redis: Redis): Promise<PairMeta[]> {
  const raw = await redis.get(PAIRS_META_CACHE_KEY);
  if (raw) return JSON.parse(raw) as PairMeta[];
  // Never published yet: same honest-empty fallback as the in-process version.
  return config.pairsUpper.map((pair) => ({
    pair,
    tradingStatus: "UNKNOWN",
    high24h: null,
    low24h: null,
    volume24h: null,
    updatedAt: null,
  }));
}

export async function getRemoteMetaFetchError(redis: Redis): Promise<string | null> {
  const raw = await redis.get(PAIRS_META_FETCH_ERROR_KEY);
  return raw && raw.length > 0 ? raw : null;
}
