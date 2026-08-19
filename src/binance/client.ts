import WebSocket from "ws";
import { config } from "../config";
import { marketStore } from "../state/marketStore";
import { BookLevel } from "../types";

// We use Binance's partial book depth stream (top 20 levels, pushed every
// 100ms by Binance itself) rather than the raw diff-depth stream. Binance
// already maintains the order book and hands us a ready-to-use snapshot per
// message. The alternative — subscribing to @depth diffs and maintaining our
// own book via a REST snapshot + sequenced diff application — is real
// engineering surface (out-of-order handling, resync-on-gap, snapshot
// staleness) that doesn't add meaningful signal for this exercise, so it's a
// deliberately scoped trade-off. See README for more.
const STREAM_SUFFIX = "depth20@100ms";

interface CombinedStreamMessage {
  stream: string;
  data: {
    lastUpdateId: number;
    bids: BookLevel[];
    asks: BookLevel[];
  };
}

function buildStreamUrl(symbolsLower: string[]): string {
  const streams = symbolsLower.map((s) => `${s}@${STREAM_SUFFIX}`).join("/");
  return `wss://stream.binance.com:9443/stream?streams=${streams}`;
}

/**
 * Maintains a single persistent connection to Binance's combined stream for
 * all tracked pairs (one socket, not one-per-pair, and not one-per-client).
 * Reconnects with exponential backoff on drop. All mobile clients share this
 * single upstream connection via the broadcaster/market store.
 */
export class BinanceIngestionClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closedByUs = false;

  start() {
    this.closedByUs = false;
    this.connect();
  }

  stop() {
    this.closedByUs = true;
    this.ws?.close();
  }

  private connect() {
    const url = buildStreamUrl(config.pairsLower);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      console.log(`[binance] connected (${config.pairsUpper.join(", ")})`);
      for (const pair of config.pairsUpper) marketStore.setConnected(pair, true);
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as CombinedStreamMessage;
        const symbolLower = msg.stream.split("@")[0];
        const pair = symbolLower.toUpperCase();
        marketStore.applyDepthUpdate(pair, msg.data.bids, msg.data.asks);
      } catch (err) {
        console.error("[binance] failed to parse message", err);
      }
    });

    ws.on("close", () => {
      for (const pair of config.pairsUpper) marketStore.setConnected(pair, false);
      if (this.closedByUs) return;
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error("[binance] socket error", err.message);
      // "close" fires after "error" for ws sockets, which triggers reconnect.
    });
  }

  private scheduleReconnect() {
    this.reconnectAttempt += 1;
    const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
    console.log(`[binance] reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => {
      if (!this.closedByUs) this.connect();
    }, delayMs);
  }
}
