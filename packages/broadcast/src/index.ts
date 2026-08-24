import "@pulsecrypto/shared/loadEnv";
import express from "express";
import compression from "compression";
import { createServer } from "http";
import Redis from "ioredis";
import { config } from "@pulsecrypto/shared/config";
import { debugLog } from "@pulsecrypto/shared/logger";
import { Broadcaster } from "./broadcast/broadcaster";
import { BinanceIngestionClient } from "@pulsecrypto/shared/binance/client";
import { getRemotePairsMeta, getRemoteMetaFetchError } from "@pulsecrypto/shared/rest/remotePairsMeta";
import { getPairsMeta, getMetaFetchError, refreshPairsMeta } from "@pulsecrypto/shared/rest/pairsMeta";
import { RemoteMarketStore } from "@pulsecrypto/shared/state/remoteMarketStore";
import { marketStore } from "@pulsecrypto/shared/state/marketStore";
import { MarketReader } from "@pulsecrypto/shared/types";

// Always serves REST + WebSocket traffic. config.appMode picks the data source:
// "distributed" reads from Redis (ingestion runs separately); "standalone" runs
// ingestion in-process (local-dev fallback). Both hand Broadcaster the same MarketReader.

const app = express();
app.use(compression());
const httpServer = createServer(app);

let redis: Redis | undefined;
let binanceClient: BinanceIngestionClient | undefined;
let remoteStore: RemoteMarketStore | undefined;

// Simple health check for load balancers, container orchestrators, etc.
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    pairs: config.pairsUpper,
    broadcastIntervalMs: config.broadcastIntervalMs,
    mode: config.appMode,
  });
});

// Fetches available pairs from config.
app.get("/pairs", (_req, res) => {
  res.json(config.pairsUpper);
});

// Fetches metadata for available pairs. (initial load and pull-to-refresh)
app.get("/pairs/meta", async (_req, res) => {
  // Body stays a plain PairMeta[]; a fetch error (if any) is a header, not a body-shape change.
  const fetchError =
    config.appMode === "standalone" ? getMetaFetchError() : await getRemoteMetaFetchError(redis!);
  if (fetchError) res.set("X-Meta-Fetch-Error", fetchError);
  res.json(config.appMode === "standalone" ? getPairsMeta()//Fetch from local cache
    : await getRemotePairsMeta(redis!)//Fetch from redis
  );
});

let broadcaster: Broadcaster;

async function main() {
  debugLog("config", "resolved config:", config);
  let store: MarketReader;

  // This segment was added under the assumption that other developers may not have Redis or Docker running locally
  // The only tradeoff for the clean architecture.
  if (config.appMode === "standalone") {
    await refreshPairsMeta();
    setInterval(() => {
      refreshPairsMeta().catch((err) => console.error("[meta] poll failed", err));
    }, config.metaPollIntervalMs);

    binanceClient = new BinanceIngestionClient();
    binanceClient.start();
    store = marketStore;
    console.log("[server] mode: standalone (in-process ingestion, no Redis)");
  } else {
    redis = new Redis(config.redisUrl);
    remoteStore = await RemoteMarketStore.create(redis, config.pairsUpper);
    store = remoteStore;
    console.log(`[server] mode: distributed (redis: ${config.redisUrl})`);
  }

  broadcaster = new Broadcaster(httpServer, store);
  broadcaster.start();

  httpServer.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(`[server] WS endpoint: ws://localhost:${config.port}${config.wsPath}`);
    console.log(`[server] tracking: ${config.pairsUpper.join(", ")}`);
    console.log(`[server] broadcast interval: ${config.broadcastIntervalMs}ms`);
  });
}

function shutdown() {
  console.log("\n[server] shutting down");
  binanceClient?.stop();
  broadcaster?.stop();
  remoteStore?.close();
  redis?.disconnect();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[server] fatal error during startup", err);
  process.exit(1);
});
