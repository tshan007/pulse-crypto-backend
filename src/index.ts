import express from "express";
import { createServer } from "http";
import { config } from "./config";
import { BinanceIngestionClient } from "./binance/client";
import { Broadcaster } from "./broadcast/broadcaster";
import { getPairsMeta, refreshPairsMeta } from "./rest/pairsMeta";

const app = express();
const httpServer = createServer(app);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", pairs: config.pairsUpper, broadcastIntervalMs: config.broadcastIntervalMs });
});

app.get("/pairs/meta", (_req, res) => {
  res.json(getPairsMeta());
});

const broadcaster = new Broadcaster(httpServer);
const binanceClient = new BinanceIngestionClient();

async function main() {
  // Fetch metadata once before accepting traffic so /pairs/meta and the
  // first broadcast tick both have real change24h figures where possible.
  await refreshPairsMeta();
  setInterval(refreshPairsMeta, config.metaPollIntervalMs);

  binanceClient.start();
  broadcaster.start();

  httpServer.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(`[server] WS endpoint: ws://localhost:${config.port}/ws`);
    console.log(`[server] tracking: ${config.pairsUpper.join(", ")}`);
    console.log(`[server] broadcast interval: ${config.broadcastIntervalMs}ms`);
  });
}

function shutdown() {
  console.log("\n[server] shutting down");
  binanceClient.stop();
  broadcaster.stop();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[server] fatal error during startup", err);
  process.exit(1);
});
