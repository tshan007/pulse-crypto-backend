import { BookLevel, PairState } from "../types";
import { config } from "../config";

/**
 * Holds live per-pair state, mutated in place — not a queue. That's what keeps the
 * broadcaster's backpressure story simple: nothing here can grow unboundedly.
 */
class MarketStore {
  private pairs = new Map<string, PairState>();

  constructor(symbolsUpper: string[]) {
    for (const pair of symbolsUpper) {
      this.pairs.set(pair, {
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
      });
    }
  }

  private sumVolume(levels: BookLevel[]): number {
    let total = 0;
    for (const [, qty] of levels) total += Number(qty);
    return total;
  }

  /** Applies a fresh order-book depth snapshot for one pair. */
  applyDepthUpdate(pair: string, bids: BookLevel[], asks: BookLevel[]) {
    const existing = this.pairs.get(pair);
    if (!existing) return;

    const topBids = bids.slice(0, config.depthLevels);
    const topAsks = asks.slice(0, config.depthLevels);

    const bestBid = topBids[0] ? Number(topBids[0][0]) : null;
    const bestAsk = topAsks[0] ? Number(topAsks[0][0]) : null;

    const price = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : existing.price;
    const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : existing.spread;

    const bidVolume = this.sumVolume(topBids);
    const askVolume = this.sumVolume(topAsks);
    const totalVolume = bidVolume + askVolume;
    const buyPressure = totalVolume > 0 ? (bidVolume / totalVolume) * 100 : existing.buyPressure;
    const sellPressure = buyPressure !== null ? 100 - buyPressure : existing.sellPressure;

    this.pairs.set(pair, {
      ...existing,
      timestamp: Date.now(),
      price,
      spread,
      buyPressure,
      sellPressure,
      bids: topBids,
      asks: topAsks,
      connected: true,
    });
  }

  /** Updates the 24h change% for a pair, sourced from the periodic REST poll. */
  applyChange24h(pair: string, change24h: number) {
    const existing = this.pairs.get(pair);
    if (!existing) return;
    this.pairs.set(pair, { ...existing, change24h });
  }

  /** Marks a pair's upstream connection status (used on connect/disconnect/reconnect). */
  setConnected(pair: string, connected: boolean) {
    const existing = this.pairs.get(pair);
    if (!existing) return;
    this.pairs.set(pair, { ...existing, connected });
  }

  getAll(): PairState[] {
    return Array.from(this.pairs.values());
  }

  getPair(pair: string): PairState | undefined {
    return this.pairs.get(pair);
  }
}

export const marketStore = new MarketStore(config.pairsUpper);
