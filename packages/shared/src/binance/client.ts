import WebSocket from "ws";
import { config } from "../config";
import { debugLog, debugTick } from "../logger";
import { marketStore } from "../state/marketStore";
import { BookLevel, PairState } from "../types";

// We use Binance's partial book depth stream (top N levels, pushed on a
// fixed cadence by Binance itself — see config.binanceDepthStreamSuffix)
// rather than the raw diff-depth stream. Binance already maintains the
// order book and hands us a ready-to-use snapshot per message. The
// alternative — subscribing to @depth diffs and maintaining our own book
// via a REST snapshot + sequenced diff application — is real engineering
// surface (out-of-order handling, resync-on-gap, snapshot staleness) that
// doesn't add meaningful signal for this exercise, so it's a deliberately
// scoped trade-off. See README for more.

interface CombinedStreamMessage {
  stream: string;
  data: {
    lastUpdateId: number;
    bids: BookLevel[];
    asks: BookLevel[];
  };
}

function buildStreamUrl(symbolsLower: string[]): string {
  const streams = symbolsLower.map((s) => `${s}@${config.binanceDepthStreamSuffix}`).join("/");
  return `${config.binanceWsBaseUrl}?streams=${streams}`;
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

  // Fires after every marketStore mutation this client makes, with that pair's fresh
  // state. Lets a caller (e.g. the ingestion process, republishing to Redis) react to
  // changes without this class knowing anything about where they're republished to.
  constructor(private onUpdate?: (pair: string, state: PairState) => void) {}

  private notify(pair: string) {
    if (!this.onUpdate) return;
    const state = marketStore.getPair(pair);
    if (state) this.onUpdate(pair, state);
  }

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
    debugLog("binance", "connecting", url);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      console.log(`[binance] connected (${config.pairsUpper.join(", ")})`);
      for (const pair of config.pairsUpper) {
        marketStore.setConnected(pair, true);
        this.notify(pair);
      }
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as CombinedStreamMessage;
        const symbolLower = msg.stream.split("@")[0];
        const pair = symbolLower.toUpperCase();
        marketStore.applyDepthUpdate(pair, msg.data.bids, msg.data.asks);
        debugTick("binance", "depth message", pair);
        this.notify(pair);
      } catch (err) {
        console.error("[binance] failed to parse message", err);
        debugLog("binance", "raw message that failed to parse:", raw.toString().slice(0, 500));
      }
    });

    ws.on("close", (code, reason) => {
      debugLog("binance", "closed", code, reason.toString());
      for (const pair of config.pairsUpper) {
        marketStore.setConnected(pair, false);
        this.notify(pair);
      }
      if (this.closedByUs) return;
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error("[binance] socket error", err.message);
      debugLog("binance", "socket error detail", err);
      // "close" fires after "error" for ws sockets, which triggers reconnect.
    });
  }

  private scheduleReconnect() {
    this.reconnectAttempt += 1;
    const { binanceReconnectBaseDelayMs: base, binanceReconnectMaxDelayMs: max } = config;
    const delayMs = Math.min(max, base * 2 ** Math.min(this.reconnectAttempt, 5));
    console.log(`[binance] reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => {
      if (!this.closedByUs) this.connect();
    }, delayMs);
  }
}
