import Redis from "ioredis";
import { debugLog } from "../logger";
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
 * Broadcast-side counterpart to `RedisPublisher` (ingestion side). Holds the same
 * shape as `MarketStore` — a local `Map<pair, PairState>` — but populates it from
 * Redis instead of from a direct Binance connection:
 *   - on startup, hydrates every tracked pair from its `market:{pair}` mirror-seed key
 *     (falling back to the same empty-state shape `MarketStore` starts with if the
 *     key hasn't been written yet), then
 *   - subscribes to `market:updates` and overwrites the relevant entry as messages
 *     arrive.
 * `Broadcaster` depends only on the `MarketReader` interface, so it needs no changes
 * to consume this instead of the in-process `MarketStore`.
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
    const keys = symbolsUpper.map((pair) => `market:${pair}`);
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
    await this.subscriber.subscribe("market:updates");
    debugLog("redis", "subscribed to market:updates");
    this.subscriber.on("message", (_channel, raw) => {
      try {
        const { pair, state } = JSON.parse(raw) as { pair: string; state: PairState };
        this.pairs.set(pair, state);
        debugLog("redis", "received update", pair, "price:", state.price);
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
