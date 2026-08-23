import Redis from "ioredis";
import { config } from "../config";
import { PairMeta } from "../types";

/**
 * Broadcast-side counterpart to `pairsMeta.ts` (which now runs only in the ingestion
 * process). Reads the two keys `RedisPublisher.publishMetaSnapshot` writes, straight
 * off Redis on every call — /pairs/meta is a low-frequency REST route, so there's no
 * need for a local cache layer here the way the ingestion side has one.
 */
export async function getRemotePairsMeta(redis: Redis): Promise<PairMeta[]> {
  const raw = await redis.get("pairsmeta:cache");
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
  const raw = await redis.get("pairsmeta:fetcherror");
  return raw && raw.length > 0 ? raw : null;
}
