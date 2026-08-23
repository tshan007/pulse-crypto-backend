import Redis from "ioredis";
import { debugLog } from "../logger";
import { PairMeta, PairState } from "../types";

/**
 * Ingestion-side counterpart to `RemoteMarketStore`/`remotePairsMeta` (broadcast side).
 * Writes go two places per update:
 *   - a plain `SET` under a per-pair key ("mirror seed") so a broadcast process that
 *     starts up before any live tick arrives still has real data to hydrate from, and
 *   - a `PUBLISH` on a shared channel so already-running broadcast processes update
 *     immediately rather than waiting on the next poll.
 * Meta (24hr ticker) has no live-push need — it's already REST-polled at low frequency —
 * so it's just two SETs, read directly by the /pairs/meta route.
 */
export class RedisPublisher {
  constructor(private redis: Redis) {}

  async publishMarketUpdate(pair: string, state: PairState): Promise<void> {
    const payload = JSON.stringify(state);
    await this.redis.set(`market:${pair}`, payload);
    await this.redis.publish("market:updates", JSON.stringify({ pair, state }));
    debugLog("redis", "published", pair, "price:", state.price, "connected:", state.connected);
  }

  async publishMetaSnapshot(metas: PairMeta[], fetchError: string | null): Promise<void> {
    await this.redis.set("pairsmeta:cache", JSON.stringify(metas));
    await this.redis.set("pairsmeta:fetcherror", fetchError ?? "");
    debugLog("redis", "published meta snapshot,", metas.length, "pairs, fetchError:", fetchError);
  }
}
