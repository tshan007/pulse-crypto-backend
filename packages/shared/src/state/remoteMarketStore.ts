import Redis from "ioredis";
import { debugLog, debugTick } from "../logger";
import { MARKET_UPDATES_CHANNEL, marketKey } from "../constants/redisKeys";
import { MarketReader, PairState } from "../types";

function emptyState(pair: string): PairState {
  return {
    pair,
    timestamp: Date.now(),
    price: null,
    spread: null,
    buyPressure: null,
    sellPressure: null,
    bids: [],
    asks: [],
    change24h: null,
    connected: false,
  };
}

/**
 * Broadcast-side counterpart to `RedisPublisher`: hydrates from Redis mirror-seed
 * keys on startup, then stays live via `market:updates` subscribe. Same `MarketReader`
 * shape as `MarketStore`, so `Broadcaster` doesn't care which one it's using.
 */
export class RemoteMarketStore implements MarketReader {
  private pairs = new Map<string, PairState>();
  private subscriber: Redis;

  private constructor(private redis: Redis, symbolsUpper: string[]) {
    this.subscriber = redis.duplicate();
  }

  static async create(redis: Redis, symbolsUpper: string[]): Promise<RemoteMarketStore> {
    const store = new RemoteMarketStore(redis, symbolsUpper);
    await store.hydrate(symbolsUpper);
    await store.subscribe();
    return store;
  }

  private async hydrate(symbolsUpper: string[]) {
    if (symbolsUpper.length === 0) return;
    const keys = symbolsUpper.map(marketKey);
    const values = await this.redis.mget(...keys);
    let hydrated = 0;
    symbolsUpper.forEach((pair, i) => {
      const raw = values[i];
      if (raw) hydrated++;
      this.pairs.set(pair, raw ? (JSON.parse(raw) as PairState) : emptyState(pair));
    });
    debugLog("redis", `hydrated ${hydrated}/${symbolsUpper.length} pairs from mirror-seed keys`);
  }

  private async subscribe() {
    await this.subscriber.subscribe(MARKET_UPDATES_CHANNEL);
    debugLog("redis", "subscribed to", MARKET_UPDATES_CHANNEL);
    this.subscriber.on("message", (_channel, raw) => {
      try {
        const { pair, state } = JSON.parse(raw) as { pair: string; state: PairState };
        this.pairs.set(pair, state);
        debugTick("redis", "received update", pair);
      } catch (err) {
        console.error("[redis] failed to parse market update", err);
        debugLog("redis", "raw message that failed to parse:", raw.slice(0, 500));
      }
    });
  }

  async close(): Promise<void> {
    await this.subscriber.quit();
  }

  getAll(): PairState[] {
    return Array.from(this.pairs.values());
  }

  getPair(pair: string): PairState | undefined {
    return this.pairs.get(pair);
  }
}
