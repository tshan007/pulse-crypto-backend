import "@pulsecrypto/shared/loadEnv";
import Redis from "ioredis";
import { config } from "@pulsecrypto/shared/config";
import { debugLog } from "@pulsecrypto/shared/logger";
import { BinanceIngestionClient } from "@pulsecrypto/shared/binance/client";
import { getPairsMeta, getMetaFetchError, refreshPairsMeta } from "@pulsecrypto/shared/rest/pairsMeta";
import { RedisPublisher } from "@pulsecrypto/shared/state/redisPublisher";

// Ingestion process: owns the single Binance WebSocket connection and the 24hr-meta
// REST poller. Publishes everything to Redis (see state/redisPublisher.ts) and serves
// no HTTP/WS traffic of its own — that's the broadcast process (packages/broadcast),
// which depends only on what's in Redis, never on this process directly.

const redis = new Redis(config.redisUrl);
const publisher = new RedisPublisher(redis);
const binanceClient = new BinanceIngestionClient((pair, state) => {
  publisher.publishMarketUpdate(pair, state).catch((err) => console.error("[redis] publish failed", err));
});

async function main() {
  debugLog("config", "resolved config:", config);
  await refreshPairsMeta();
  await publisher.publishMetaSnapshot(getPairsMeta(), getMetaFetchError());
  setInterval(() => {
    refreshPairsMeta()
      .then(() => publisher.publishMetaSnapshot(getPairsMeta(), getMetaFetchError()))
      .catch((err) => console.error("[redis] meta publish failed", err));
  }, config.metaPollIntervalMs);

  binanceClient.start();
  console.log(`[ingestion] tracking: ${config.pairsUpper.join(", ")}`);
  console.log(`[ingestion] redis: ${config.redisUrl}`);
}

function shutdown() {
  console.log("\n[ingestion] shutting down");
  binanceClient.stop();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[ingestion] fatal error during startup", err);
  process.exit(1);
});
