import WebSocket, { WebSocketServer } from "ws";
import { encode } from "@msgpack/msgpack";
import { Server as HttpServer } from "http";
import { config } from "@pulsecrypto/shared/config";
import { debugLog } from "@pulsecrypto/shared/logger";
import { ClientMessage, MarketReader, ServerMessage, WireFormat } from "@pulsecrypto/shared/types";

// Protocol-level safety bound on how far a client can throttle itself down,
// not a deployment setting — deliberately not in config.ts/.env.
const MAX_CLIENT_INTERVAL_MS = 5000;

// A client can only ever throttle *down* from the base tick, never faster —
// the base tick is the real ceiling on how fresh the upstream data is.
function effectiveIntervalFor(requested: number): number {
  const clamped = Number.isFinite(requested) ? Math.min(MAX_CLIENT_INTERVAL_MS, Math.max(0, requested)) : 0;
  return Math.max(config.broadcastIntervalMs, clamped);
}

interface ClientState {
  format: WireFormat;
  effectiveIntervalMs: number;
  lastSentAt: number;
}

/**
 * Runs the WebSocket server mobile clients connect to, and the broadcast
 * loop that pushes market state to them.
 *
 * Backpressure strategy (the assignment explicitly calls this out):
 * We never queue individual Binance ticks per client. Each tick, we sample
 * whatever the current state is in the market store and send that single
 * snapshot. This means:
 *   - No per-client queue exists that could grow unboundedly from a burst
 *     of upstream ticks — a slow client simply misses intermediate states
 *     and catches up to the latest one next tick. Coalescing is implicit.
 *   - The remaining risk is the client's own TCP socket buffer filling up
 *     because the network/device can't drain it fast enough. We guard that
 *     explicitly via `ws.bufferedAmount`: if a client is backlogged past
 *     MAX_CLIENT_BUFFERED_BYTES, we skip sending them this tick rather than
 *     letting `ws.send()` pile more data into an already-full buffer.
 *
 * Per-client format & cadence: each connection can send a `{ type:
 * "configure", intervalMs?, format? }` control message (JSON, always — the
 * control channel itself never switches to binary) to pick its own encoding
 * (JSON or msgpack) and broadcast cadence at runtime, without reconnecting.
 * There's still a single global setInterval at config.broadcastIntervalMs —
 * per-client cadence is achieved by gating sends within that tick rather
 * than by spinning up a timer per connection.
 */
export class Broadcaster {
  private wss: WebSocketServer;
  private intervalHandle: NodeJS.Timeout | null = null;
  private clientState = new Map<WebSocket, ClientState>();

  constructor(httpServer: HttpServer, private store: MarketReader) {
    this.wss = new WebSocketServer({ server: httpServer, path: config.wsPath });

    this.wss.on("connection", (ws) => {
      console.log(`[ws] client connected (${this.wss.clients.size} total)`);
      this.clientState.set(ws, {
        format: "json",
        effectiveIntervalMs: config.broadcastIntervalMs,
        lastSentAt: 0,
      });

      // Send an immediate snapshot on connect so the client doesn't wait
      // up to intervalMs for its first paint. Always JSON — the client
      // hasn't had a chance to configure() yet.
      const sent = this.trySend(ws, JSON.stringify(this.buildSnapshotMessage()));
      if (sent) {
        const state = this.clientState.get(ws);
        if (state) state.lastSentAt = Date.now();
      }

      ws.on("message", (raw, isBinary) => {
        this.handleClientMessage(ws, raw, isBinary);
      });

      ws.on("close", () => {
        this.clientState.delete(ws);
        console.log(`[ws] client disconnected (${this.wss.clients.size} total)`);
      });

      ws.on("error", (err) => {
        console.error("[ws] client socket error", err.message);
        debugLog("ws", "client socket error detail", err);
      });
    });
  }

  // Parses/validates a client's control message defensively — malformed
  // input is logged and ignored, never crashes the connection or process.
  private handleClientMessage(ws: WebSocket, raw: WebSocket.RawData, isBinary: boolean) {
    const state = this.clientState.get(ws);
    if (!state) return;

    if (isBinary) {
      console.warn("[ws] ignoring binary client message (control channel is JSON-only)");
      return;
    }

    let parsed: unknown;
    try {
      const text = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : raw.toString("utf8");
      parsed = JSON.parse(text);
    } catch {
      console.warn("[ws] ignoring malformed JSON from client");
      return;
    }

    if (typeof parsed !== "object" || parsed === null || (parsed as { type?: unknown }).type !== "configure") {
      console.warn("[ws] ignoring client message with unknown/invalid shape");
      return;
    }
    const msg = parsed as Partial<ClientMessage>;

    if (msg.format !== undefined) {
      if (msg.format === "json" || msg.format === "msgpack") {
        state.format = msg.format;
      } else {
        console.warn(`[ws] ignoring unsupported format "${msg.format}"`);
      }
    }

    if (msg.intervalMs !== undefined) {
      if (typeof msg.intervalMs === "number") {
        state.effectiveIntervalMs = effectiveIntervalFor(msg.intervalMs);
      } else {
        console.warn("[ws] ignoring non-numeric intervalMs");
      }
    }

    debugLog("ws", "client configured", { format: state.format, effectiveIntervalMs: state.effectiveIntervalMs });
  }

  private buildSnapshotMessage(): ServerMessage {
    return { type: "snapshot", data: this.store.getAll() };
  }

  private trySend(ws: WebSocket, payload: string | Uint8Array): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > config.maxClientBufferedBytes) {
      // Client can't keep up — skip this tick for them rather than growing
      // their buffer further. They'll get a fresh (more current) snapshot
      // on the next tick once they've drained.
      debugLog("ws", "backpressure skip, bufferedAmount:", ws.bufferedAmount);
      return false;
    }
    ws.send(payload);
    return true;
  }

  start() {
    this.intervalHandle = setInterval(() => {
      if (this.wss.clients.size === 0) return; // nothing to do
      const message = this.buildSnapshotMessage();
      const jsonPayload = JSON.stringify(message);
      let msgpackPayload: Uint8Array | null = null;
      const now = Date.now();

      for (const client of this.wss.clients) {
        const state = this.clientState.get(client);
        if (!state) continue;
        if (now - state.lastSentAt < state.effectiveIntervalMs) continue; // not due yet

        const payload =
          state.format === "msgpack" ? (msgpackPayload ??= encode(message)) : jsonPayload;

        if (this.trySend(client, payload)) state.lastSentAt = now;
      }
    }, config.broadcastIntervalMs);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.wss.close();
  }
}
