import WebSocket from "ws";
import { config } from "../config";
import { debugLog, debugTick } from "../logger";
import { marketStore } from "../state/marketStore";
import { BookLevel, PairState } from "../types";

// Uses Binance's partial book depth stream (ready-made top-N snapshot) rather than
// raw diff-depth + manual book maintenance — see README's Key Decisions for why.

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

/** Single persistent connection to Binance's combined stream for all tracked pairs — reconnects with exponential backoff on drop. */
export class BinanceIngestionClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closedByUs = false;

  // Notifies the caller (e.g. ingestion, to republish to Redis) after each mutation.
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
