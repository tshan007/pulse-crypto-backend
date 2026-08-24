import Redis from "ioredis";
import { debugLog, debugTick } from "../logger";
import { MARKET_UPDATES_CHANNEL, PAIRS_META_CACHE_KEY, PAIRS_META_FETCH_ERROR_KEY, marketKey } from "../constants/redisKeys";
import { PairMeta, PairState } from "../types";

/** Ingestion-side counterpart to `RemoteMarketStore`/`remotePairsMeta` (broadcast side). */
export class RedisPublisher {
  constructor(private redis: Redis) {}

  async publishMarketUpdate(pair: string, state: PairState): Promise<void> {
    // SET is the mirror-seed a fresh broadcast process hydrates from; PUBLISH pushes
    // the update to already-running ones immediately.
    const payload = JSON.stringify(state);
    await this.redis.set(marketKey(pair), payload);
    await this.redis.publish(MARKET_UPDATES_CHANNEL, JSON.stringify({ pair, state }));
    debugTick("redis", "published", pair);
  }

  async publishMetaSnapshot(metas: PairMeta[], fetchError: string | null): Promise<void> {
    await this.redis.set(PAIRS_META_CACHE_KEY, JSON.stringify(metas));
    await this.redis.set(PAIRS_META_FETCH_ERROR_KEY, fetchError ?? "");
    debugLog("redis", "published meta snapshot,", metas.length, "pairs, fetchError:", fetchError);
  }
}
