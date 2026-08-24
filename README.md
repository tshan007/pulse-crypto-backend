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
npm run docker:up              # default: docker-compose.yml, bundled redis, .env.development
```

```bash
npm run docker:up:uat          # docker-compose.uat.yml, .env.uat
```
```bash
npm run docker:up:production   # docker-compose.production.yml, .env.production
```
### Debug mode: `:debug` script

```bash
npm run docker:up:debug  # same as docker:up, + DEBUG=true (docker-compose.debug.yml overlay)
```

`docker-compose.yml` bundles its own local `redis`, works out of the box with no real
infra, and reads `.env.development`. `.env.uat`/`.env.production` are different in kind,
not just config: they intentionally point at a real external `REDIS_URL` that doesn't
exist yet, so `docker-compose.{uat,production}.yml` have no bundled `redis` at all —
those two only prove the plumbing works until someone fills in a real host. (There used
to be a separate `docker-compose.development.yml` too, but once the default file also
started reading `.env.development`, the two were near-duplicates — merged into one.)

### Testing horizontal scale locally: `docker-compose.scale.yml`

```bash
npm run docker:up:scale   # broadcast x2, own project (pulsecrypto-scale), unpublished/dynamic host ports
```

`broadcast` gets a random host port per replica instead of a fixed 8080 — find each
one with `docker compose -p pulsecrypto-scale ps`. `ingestion` stays at one replica.

##

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

## Architectural decisions

- Partial book depth stream (`depth20@100ms`), not diff-depth + manual book merge —
  simpler, top-20 levels is enough for a viewer, not an execution engine.
- Live state overwritten in place (`Map<pair, PairState>`), not a queue — bursts of
  ticks collapse into one broadcast automatically.
- Backpressure via `ws.bufferedAmount`, skip-tick for slow clients — no app-level
  queue to grow unboundedly.
- Per-client format/cadence via a `configure` WebSocket message, not a new endpoint —
  one global tick, gated per client, clamped to 5000ms max.
- Single shared upstream Binance connection — client count never multiplies Binance
  connections/rate limits.
- 24h change polled via REST (~10s) and merged into the same state — depth stream
  doesn't carry it.
- No mock data on Binance REST failure — serve last-known-real or explicit
  `UNKNOWN`, error surfaced via `X-Meta-Fetch-Error`, never a fabricated number.
- Ingestion and broadcast split, Redis is the only channel between them — no shared
  memory.
- npm-workspaces monorepo — `ingestion`/`broadcast` depend only on
  `@pulsecrypto/shared`, never each other.
- `MAX_CLIENT_INTERVAL_MS` is a protocol constant in code, not `.env` — it's a wire
  contract with the mobile client, not deployment config.
- `APP_ENV` unset defaults to `"development"` everywhere (npm scripts and Docker),
  not plain `.env`.
- High-frequency debug events are throttled into periodic summaries (`debugTick`),
  not logged per-tick — avoids console flooding at 100 pairs.
- Redis key/channel names centralized in `constants/redisKeys.ts` — one source of
  truth for publisher and subscriber.
- Docker: one default compose file + a debug overlay (`environment:` merges safely
  across `-f` files) + a standalone scale file (`ports:` doesn't merge, so scaling
  needs its own file) — `--scale` uses unpublished/random host ports to dodge a
  Windows/Docker Desktop port-range race.
- Mobile client's backend host/port/TLS are env-driven, with a platform-aware
  default (`10.0.2.2` for Android emulator).

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

## Assumptions made

- 100 pairs is the tested ceiling — no critical performance hit observed at that scale.
- Top-10 depth levels (configurable) is enough for the mobile detail view; stream carries 20.
- A market *viewer* doesn't need execution-grade order book accuracy.
- Local dev happens on Docker Desktop (Windows/WSL2) — some tooling (e.g. dynamic
  scale ports) works around its quirks rather than assuming Linux-only.
- Mobile client owns its own reconnect/backoff — backend doesn't coordinate client retries.

## Trade-offs considered

- No load balancer in front of scaled `broadcast` replicas — horizontal scaling
  works, but isn't yet reachable behind one address.
- No Redis Sentinel / ingestion leader-election / multi-instance HA — scoped, not
  built, additive later.
- No historical price storage/candles — out of scope per the spec.
- Per-client cadence via one gated `setInterval`, not a timer per connection.
- No dedicated Binance REST API client — one call site today, nothing to
  streamline yet; revisit if a second endpoint gets added.
- No per-instance identifier in logs — fine at one replica each; needed once
  broadcast is actually scaled behind a load balancer.

## AI-assisted development

Built the MVP collaboratively with Claude (Anthropic) — architectural discussion, code generation,
and in-sandbox verification: dependency install, typecheck, a live end-to-end WebSocket
smoke test (snapshot delivery at the configured interval, honest empty-value fallback when
Binance is unreachable).
And I steered follow-up iteration — revisit the architecture, reviewing behavior, flagging bugs and rough edges, and
directing feature/refactor work — through to the current state.

