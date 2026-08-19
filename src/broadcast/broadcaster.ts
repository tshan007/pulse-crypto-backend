import WebSocket, { WebSocketServer } from "ws";
import { Server as HttpServer } from "http";
import { config } from "../config";
import { marketStore } from "../state/marketStore";
import { ServerMessage } from "../types";

/**
 * Runs the WebSocket server mobile clients connect to, and the fixed-interval
 * broadcast loop that pushes market state to them.
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
 */
export class Broadcaster {
  private wss: WebSocketServer;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(httpServer: HttpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    this.wss.on("connection", (ws) => {
      console.log(`[ws] client connected (${this.wss.clients.size} total)`);
      // Send an immediate snapshot on connect so the client doesn't wait
      // up to intervalMs for its first paint.
      this.sendTo(ws, this.buildSnapshotMessage());

      ws.on("close", () => {
        console.log(`[ws] client disconnected (${this.wss.clients.size} total)`);
      });

      ws.on("error", (err) => {
        console.error("[ws] client socket error", err.message);
      });
    });
  }

  private buildSnapshotMessage(): ServerMessage {
    return { type: "snapshot", data: marketStore.getAll() };
  }

  private sendTo(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > config.maxClientBufferedBytes) {
      // Client can't keep up — skip this tick for them rather than growing
      // their buffer further. They'll get a fresh (more current) snapshot
      // on the next tick once they've drained.
      return;
    }
    ws.send(JSON.stringify(message));
  }

  start() {
    this.intervalHandle = setInterval(() => {
      if (this.wss.clients.size === 0) return; // nothing to do
      const message = this.buildSnapshotMessage();
      for (const client of this.wss.clients) {
        this.sendTo(client, message);
      }
    }, config.broadcastIntervalMs);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.wss.close();
  }
}
