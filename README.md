# PulseCrypto — Backend

A Node.js market data gateway between Binance's public WebSocket streams and the PulseCrypto mobile app.

> This is the backend half of PulseCrypto. The mobile app lives in a companion repo,
> **pulsecrypto-mobile**, and expects this service running on `localhost:8080` by default.

## Setup

```bash
npm install       # installs all workspaces (packages/shared, ingestion, broadcast)
```

`npm install` at the repo root is enough — this is an npm-workspaces monorepo (see
Architecture below), not three separate installs. 

## Run

The backend is two processes sharing state through Redis: `ingestion` (the Binance
connection + meta poller) and `broadcast` (REST + WebSocket server for mobile clients).
Broadcast has nothing to serve until ingestion has published at least once, and both need
`REDIS_URL` pointing at the same Redis instance (default `redis://localhost:6379`).

```bash
npm run docker:up       # default: docker-compose.yml, bundled redis, .env.development
```

or run everything locally without Docker (needs a local Redis separately):

```bash
npm run dev:ingestion   # terminal 1 — Binance connection + meta poller
npm run dev:broadcast   # terminal 2 — REST + WebSocket server
```

```bash
npm run build            # compile packages/shared, then packages/ingestion + packages/broadcast
npm run start:ingestion  # run compiled ingestion
npm run start:broadcast  # run compiled broadcast
```
```bash
npm run typecheck
```
### No Docker, no Redis: `:local` scripts

```bash
npm run dev:broadcast:local     # or: npm run start:broadcast:local (after npm run build)
```

`.env.local` is checked into the repo directly. One process, no
second terminal, no Redis. It sets `APP_MODE=standalone`, which makes
`packages/broadcast/src/index.ts` run the Binance connection in-process instead of
expecting a separate `packages/ingestion` process + Redis. 

*It's a local-dev fallback, not a deployment target — no split, no horizontal scaling.

### Other environments: `.env.{name}` + script aliases

`.env.development`, `.env.uat` and `.env.production` are all checked in the same way, but
differ in what their `REDIS_URL` actually points at: `.env.uat`/`.env.production` hold a
real external host that doesn't exist yet (edit it once real infra does).

```bash
npm run dev:broadcast:uat            # broadcast, pointed at .env.uat
npm run dev:ingestion:uat            # ingestion, pointed at .env.uat (needed — uat is distributed mode)

npm run build
npm run start:broadcast:production   # production: start:* only, deliberately no dev:*:production
npm run start:ingestion:production   #   — never run unbuilt/watch-mode (tsx watch) code in production
```

Each script is `cross-env APP_ENV=<name> tsx watch ...` / `... node packages/*/dist/...`
(see `package.json`) — `cross-env` so the `APP_ENV=` prefix works identically on
PowerShell, cmd, and bash, since that syntax alone is bash-only.
`packages/shared/src/loadEnv.ts` reads `APP_ENV` (default `"development"`, see above) and
loads `.env.{APP_ENV}`.



### Docker per environment

```bash
npm run docker:up:development  # docker-compose.development.yml, .env.development          
```

```bash
npm run docker:up:uat          # docker-compose.uat.yml, .env.uat
```
```bash
npm run docker:up:production   # docker-compose.production.yml, .env.production
```
### Debug mode: `:debug` script

```bash
npm run docker:up:development:debug  # same, + DEBUG=true (docker-compose.development.debug.yml overlay)
```

`docker-compose.yml` (default) and `docker-compose.development.yml` both bundle their own
local `redis` container, work out of the box with no real infra, and read `.env.development`
— they differ only in Redis exposure: `development`'s isn't exposed on the host (`redis`
service, no `ports:`), specifically so it can't collide with the default's
`0.0.0.0:6379->6379` if both happen to run at once. `.env.uat`/
`.env.production` are different in kind, not just config: they intentionally point at a
real external `REDIS_URL` that doesn't exist yet, so `docker-compose.{uat,production}.yml`
have no bundled `redis` at all — those two only prove the plumbing works until someone
fills in a real host.

The broadcast process starts on `http://localhost:8080` by default.

- REST: `GET /health`, `GET /pairs`, `GET /pairs/meta`
- WebSocket: `ws://localhost:8080/ws`

`GET /pairs` returns the supported symbols as a plain JSON array:

```json
["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "XRPUSDT"]
```

## Architecture

```
                              ingestion process
Binance combined WS stream (depth20@100ms, 100 pairs)
        │  single persistent connection
        ▼
BinanceIngestionClient  — parses messages, applies to local MarketStore,
        │                  then republishes (redisPublisher.ts)
        ▼
Redis   — SET market:{pair}  (mirror seed)      SET pairsmeta:cache / :fetcherror
        — PUBLISH market:updates                (from the meta poller, every 10s)
        │
        ▼                             broadcast process
RemoteMarketStore — hydrates from Redis on boot, then mirrors live via subscribe
        ▼
Broadcaster — samples the mirror every BROADCAST_INTERVAL_MS (base tick, default
              100ms), sends each client a snapshot in their own format/cadence
        │  ▲
        ▼  │  client → server: {"type":"configure", intervalMs?, format?}
Mobile clients (N)  — WebSocket, one connection each
```

Ingestion and broadcast share no memory — everything crosses through Redis. This was a
deliberate migration (see `state/redisPublisher.ts`, `state/remoteMarketStore.ts`,
`rest/remotePairsMeta.ts` under `packages/shared/src/`): it's the first two steps toward
horizontally scaling the broadcast tier independently of the single Binance connection,
without the mobile app's REST/WebSocket contract changing at all. Redis Sentinel, multiple
broadcast instances behind a load balancer, and ingestion leader-election/failover are
deliberately **not** built yet — deferred until client scale or reliability requirements
actually call for them (see Trade-offs below).

The meta poller (`packages/shared/src/rest/pairsMeta.ts`, run from
`packages/ingestion/src/index.ts`, default every 10s) hits Binance's
`/api/v3/ticker/24hr` REST endpoint once, and feeds the result into **both** the
Redis-cached `/pairs/meta` response and the live market state's `change24h` field — one
HTTP call serves both purposes.

### npm-workspaces monorepo

```
packages/
  shared/      config, types, logger, loadEnv, BinanceIngestionClient, MarketStore,
               RedisPublisher, RemoteMarketStore, pairsMeta/remotePairsMeta — everything
               both sides need (broadcast's APP_MODE=standalone path uses these directly,
               so they can't live in ingestion)
  ingestion/   src/index.ts — orchestrates BinanceIngestionClient + the meta poller +
               RedisPublisher, all from @pulsecrypto/shared
  broadcast/   src/index.ts + src/broadcast/broadcaster.ts (the one file that stays here,
               since only broadcast uses it)
```

`ingestion` and `broadcast` each depend on `@pulsecrypto/shared` and never on each other —
a real package boundary, not just convention.

Cross-package imports (`@pulsecrypto/shared/config`, ...) resolve differently in dev vs.
prod, so `packages/ingestion` and `packages/broadcast` each carry two tsconfigs:
- `tsconfig.json` (dev, typecheck) aliases straight to shared's `src/*.ts` — no separate
  shared build/watch needed.
- `tsconfig.build.json` (prod build) resolves against shared's compiled `dist/*.d.ts`
  instead, so `npm run build:shared` has to run first (the root `build` script always
  does).

At runtime, `require("@pulsecrypto/shared/config")` resolves through the npm-workspaces
symlink and shared's `package.json` `exports` map — no bundler or path-alias tooling
needed.

One limitation: npm workspaces symlinks every package into root `node_modules` regardless
of declared `dependencies`, so nothing at the module-resolution level actually *prevents*
`packages/broadcast` from importing `@pulsecrypto/ingestion` — the boundary is enforced by
each package's `dependencies` and code review, not a hard resolution wall.

### Key decisions

**Partial book depth stream, not diff-depth + snapshot merge.** `<symbol>@depth20@100ms`
gives a ready-made top-20 snapshot; the alternative is applying `@depth` diffs to a REST
snapshot yourself, handling sequence numbers and gap resync. Chose the snapshot stream —
simpler and more robust, at the cost of only seeing the top 20 levels. Fine for a market
*viewer*, not an execution engine.

**State, not a queue, is what gets broadcast.** Every Binance message overwrites fields in
a `Map<pair, PairState>` in place; the broadcaster's interval timer just serializes
whatever that map currently holds. This is the "buffer and/or batch, emit at a
configurable interval" requirement in practice: a burst of 50 Binance messages in one
100ms window collapses into exactly one outbound message, since they're all overwriting
the same shared state.

**Backpressure guard is about socket buffers, not app-level queues.** With no app-level
queue, the only thing that can grow unboundedly is a slow client's outbound TCP socket
buffer. Before each send, the broadcaster checks `ws.bufferedAmount`; a client backlogged
past `MAX_CLIENT_BUFFERED_BYTES` (default 1MB) is skipped for that tick rather than queued
further, and picks up with a fresher snapshot next tick.

**Per-client format & cadence, via a control message, not a new endpoint.** A client sends
`{"type":"configure","intervalMs":500,"format":"msgpack"}` over its open WebSocket to
switch between JSON/msgpack and/or request a slower cadence, no reconnect needed.
`intervalMs` is clamped to 5000ms max, and the effective interval is always
`max(BROADCAST_INTERVAL_MS, clampedRequest)` — a client can only throttle down from the
base tick, never faster. There's still one global `setInterval`; per-client cadence comes
from gating within that tick (`now - lastSentAt >= effectiveIntervalMs`), not a timer per
connection. Malformed control messages are logged and ignored, never close the connection.

**One upstream connection, not one per client.** All mobile clients share a single Binance
WebSocket connection via the shared market store — Binance connection count and rate
limits are decoupled from mobile client count.

**24hr change is polled, not streamed.** The depth stream doesn't carry 24h change, so
`change24h` is refreshed via a periodic low-frequency REST poll and merged into the same
`PairState`. Updates every ~10s instead of every 100ms — acceptable since 24h change moves
slowly anyway.

**No mock data — honest degradation on Binance REST failure instead.** If
`/api/v3/ticker/24hr` fails, the backend never fabricates numbers:
- Previous successful fetch exists → keep serving that cached real data (stale-but-real
  beats fake-but-fresh); `change24h` stays untouched rather than overwritten.
- Never fetched successfully → `GET /pairs/meta` returns `null` high/low/volume and
  `tradingStatus: "UNKNOWN"` — an honest "don't know yet" instead of plausible fake data.
- Every failure is logged, and the latest error is exposed via `X-Meta-Fetch-Error` on
  `/pairs/meta`, so callers can detect degraded data without a response-shape change.

Both paths have been exercised end-to-end: the never-fetched fallback (confirmed clean
nulls/`UNKNOWN`, header carrying the real `403` Binance returned when outbound access was
blocked), and the live path once outbound access was available — real Binance data flowing
ingestion → Redis → broadcast → a connected WebSocket client.

### Payload shape

```json
{
  "type": "snapshot",
  "data": [
    {
      "pair": "BTCUSDT",
      "timestamp": 1720802025000,
      "price": 109235.42,
      "spread": 0.41,
      "buyPressure": 63.2,
      "sellPressure": 36.8,
      "bids": [["109235.10", "0.421"], ...],
      "asks": [["109235.51", "0.288"], ...],
      "change24h": 1.82,
      "connected": true
    }
  ]
}
```

`price` is the mid-price (best bid + best ask) / 2. `buyPressure`/`sellPressure` are the
share of visible top-10-level volume on each side, summing to 100.

## Assumptions

- 5 fixed pairs is sufficient (config-driven via `PAIRS` env var if more are wanted).
- Top-10 order book levels (configurable via `DEPTH_LEVELS`) are enough for the mobile
  detail view; the underlying Binance stream carries 20.
- A market *viewer* doesn't need execution-grade order book accuracy, justifying the
  partial-depth-stream trade-off above.

### Configuration

Every deployment-specific value lives in `.env` (see `.env.example`) — WS path, broadcast
interval, backpressure threshold, tracked pairs, depth levels, Binance WS/REST base URLs,
depth stream suffix, reconnect backoff, meta poll interval, fetch timeout, `REDIS_URL`
(default `redis://localhost:6379`, `redis://redis:6379` inside Docker), and `APP_MODE`
(`distributed` default, or `standalone` — see Run above). `packages/shared/src/config.ts`
is the single place that reads `process.env`; nothing under `packages/*/src/` hardcodes a
URL, port, or timing value. Both processes read the same `.env`/`config.ts` — only
`REDIS_URL` typically needs to differ, and only when they're off the same Docker network.

REST responses are gzip-compressed via Express's `compression()` middleware — transparent
to any `fetch`-based client. Its ~1KB size threshold means `/pairs`/`/pairs/meta` may
legitimately skip `Content-Encoding: gzip` at a small pair count; that's the middleware
correctly skipping compression not worth the CPU, not a misconfiguration.

## Trade-offs not taken further (given scope)

- Ingestion and broadcast are split and Redis-backed (see Architecture above), but only
  one instance of each runs, and there's no load balancer — not needed at current client
  scale. The remaining HA work (Redis Sentinel, N broadcast instances behind a load
  balancer, active/standby ingestion with leader election) is scoped but deliberately not
  built; it's additive on top of what exists here, not a rework of it.
- No historical price storage/candles — out of scope per the spec (current price + book only).
- Per-client cadence is implemented by gating sends within the single existing base-tick
  `setInterval`, not by running a timer per connection — simpler and keeps resource usage
  bounded regardless of how many clients pick a slower interval than the base tick.

## AI-assisted development

Built collaboratively with Claude (Anthropic) — architectural discussion, code generation,
and in-sandbox verification: dependency install, typecheck, a live end-to-end WebSocket
smoke test (snapshot delivery at the configured interval, honest empty-value fallback when
Binance is unreachable), and the discovery/fix of a real bug where `.env` was never
actually being loaded (Node doesn't read `.env` files without an explicit loader).
