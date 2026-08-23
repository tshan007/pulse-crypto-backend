# PulseCrypto — Backend

A Node.js market data gateway between Binance's public WebSocket streams and the PulseCrypto mobile app.

> This is the backend half of PulseCrypto. The mobile app lives in a companion repo,
> **pulsecrypto-mobile**, and expects this service running on `localhost:8080` by default.

## Setup

```bash
npm install       # installs all workspaces (packages/shared, ingestion, broadcast)
cp .env.example .env
```

`npm install` at the repo root is enough — this is an npm-workspaces monorepo (see
Architecture below), not three separate installs. `.env` is only needed for the
unsuffixed `dev:broadcast`/`dev:ingestion`/default `docker compose up --build` flows;
skip it entirely if you're going straight for one of the ready-to-use, already-committed
environments instead (`.env.local` needs no Docker/Redis at all — see Run below).

## Run

The backend is two processes sharing state through Redis: `ingestion` (the Binance
connection + meta poller) and `broadcast` (REST + WebSocket server for mobile clients).
Broadcast has nothing to serve until ingestion has published at least once, and both need
`REDIS_URL` pointing at the same Redis instance (default `redis://localhost:6379`).

```bash
docker compose up --build   # redis + ingestion + broadcast, one command
```

or run everything locally without Docker (needs a local Redis separately):

```bash
npm run dev:ingestion   # terminal 1 — Binance connection + meta poller
npm run dev:broadcast   # terminal 2 — REST + WebSocket server
npm run build            # compile packages/shared, then packages/ingestion + packages/broadcast
npm run start:ingestion  # run compiled ingestion
npm run start:broadcast  # run compiled broadcast
npm run typecheck
```

### No Docker, no Redis: `:local` scripts

```bash
npm run dev:broadcast:local     # or: npm run start:broadcast:local (after npm run build)
```

`.env.local` is checked into the repo directly, so there's no copy step. One process, no
second terminal, no Redis. It sets `APP_MODE=standalone`, which makes
`packages/broadcast/src/index.ts` run the Binance connection in-process instead of
expecting a separate `packages/ingestion` process + Redis — the same in-memory store this
backend had before the Redis split. It's a local-dev fallback, not a deployment target —
no split, no horizontal scaling.

### Other environments: `.env.{name}` + script aliases

`.env.uat`, `.env.development`, and `.env.production` are all checked in the same way, but
differ in what their `REDIS_URL` actually points at: `.env.uat`/`.env.production` hold a
real external host that doesn't exist yet (edit it once real infra does); `.env.development`
defaults to `redis://localhost:6379` like plain `.env` — the `dev:*:development`/
`start:*:development` scripts below need a real local Redis reachable there (same
requirement as the unsuffixed scripts above), while `docker:up:development` (see Docker
per environment below) bundles its own and needs nothing extra.

```bash
npm run dev:broadcast:uat            # broadcast, pointed at .env.uat
npm run dev:ingestion:uat            # ingestion, pointed at .env.uat (needed — uat is distributed mode)

npm run dev:broadcast:development    # same shape, .env.development
npm run dev:ingestion:development

npm run build
npm run start:broadcast:production   # production: start:* only, deliberately no dev:*:production
npm run start:ingestion:production   #   — never run unbuilt/watch-mode (tsx watch) code in production
```

Each script is `cross-env APP_ENV=<name> tsx watch ...` / `... node packages/*/dist/...`
(see `package.json`) — `cross-env` so the `APP_ENV=` prefix works identically on
PowerShell, cmd, and bash, since that syntax alone is bash-only.
`packages/shared/src/loadEnv.ts` reads `APP_ENV` and loads `.env.{APP_ENV}` instead of the
plain `.env`, falling back to `.env` if it's unset or that file doesn't exist — so the
plain `dev:broadcast`/`dev:ingestion` scripts (no suffix) are untouched and keep reading
`.env` as before.

`.env.uat` tracks a reduced 10-pair set for a faster loop; `.env.development`,
`.env.production`, and plain `.env` all track the full 100-pair list (each file's `PAIRS`
is independent — edit any one without affecting the others).

Add a new environment by creating `.env.{name}` and a matching pair of script aliases in
`package.json`. Files matching `.env.*` are gitignored by default (same as `.env`) unless
explicitly excepted in `.gitignore` — `.env.local`, `.env.uat`, `.env.development`, and
`.env.production` all are (none hold real secrets, just placeholder/local-only values), so
all four are checked in directly. If `REDIS_URL` (or anything else) ever needs a real
secret for a given environment, inject it via your deployment platform's secret store
instead of committing it — don't let that stop being true for any of these files.

### Docker per environment

```bash
npm run docker:up              # default: docker-compose.yml, bundled redis, plain .env
npm run docker:up:uat          # docker-compose.uat.yml, .env.uat
npm run docker:up:development  # docker-compose.development.yml, .env.development
npm run docker:up:production   # docker-compose.production.yml, .env.production

npm run docker:down            # and the :uat / :development / :production counterparts
```

`docker-compose.yml` (default) and `docker-compose.development.yml` both bundle their own
local `redis` container and work out of the box with no real infra — `development`'s isn't
exposed on the host (`redis` service, no `ports:`), specifically so it can't collide with
the default's `0.0.0.0:6379->6379` if both happen to run at once. `.env.uat`/
`.env.production` are different in kind, not just config: they intentionally point at a
real external `REDIS_URL` that doesn't exist yet, so `docker-compose.{uat,production}.yml`
have no bundled `redis` at all — those two only prove the plumbing works until someone
fills in a real host. Each compose file is self-contained rather than a Compose override
layered on the default, specifically so a base-file `environment:` override can't silently
leak into the ones that need the real host to flow through untouched (Compose merges
`environment:` maps across `-f` layers otherwise).

Each `docker:*` script passes `-p pulsecrypto-<env>` so the non-default stacks get their own
Compose project name — you can bring up `uat` and `development` at once locally without
their containers/networks colliding. Add a new environment by creating
`docker-compose.{name}.yml` (copy `docker-compose.uat.yml` as a starting point) and a
matching `docker:up:{name}`/`docker:down:{name}` pair in `package.json`.

### Debug mode: `:debug` scripts

```bash
npm run dev:broadcast:debug
npm run dev:ingestion:debug
```

Verbose, high-volume logging for troubleshooting — every Redis publish/subscribe with the
pair and price, every Binance message's bid/ask counts, WS client connect/configure/
backpressure-skip events, and the fully-resolved config dumped at startup (the fastest way
to confirm which `.env` actually got picked up). Off by default; each `:debug` script is
`cross-env DEBUG=true tsx watch ...` (see `package.json` and
`packages/shared/src/logger.ts`'s `debugLog`). Combine with an environment manually if
needed, e.g.
`npx cross-env APP_ENV=uat DEBUG=true npm run dev:broadcast` — there's no dedicated
`:uat:debug` alias since that combination is rare enough not to warrant one.

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

The code boundary between ingestion and broadcast used to be convention only — any file
could `import` any other. It's now a real package boundary:

```
packages/
  shared/      config, types, logger, loadEnv, BinanceIngestionClient, MarketStore,
               RedisPublisher, RemoteMarketStore, pairsMeta/remotePairsMeta — everything
               both sides need (BinanceIngestionClient/MarketStore/pairsMeta are here,
               not in ingestion, because broadcast's APP_MODE=standalone path uses them
               directly)
  ingestion/   just its own src/index.ts — orchestrates BinanceIngestionClient + the meta
               poller + RedisPublisher, all from @pulsecrypto/shared
  broadcast/   src/index.ts + src/broadcast/broadcaster.ts (the one file that stays here
               rather than in shared, since only broadcast uses it)
```

`ingestion` and `broadcast` each depend on `@pulsecrypto/shared` (declared in their own
`package.json`) and never on each other. Every `npm run` script still runs from the repo
root (never `-w packages/x`) — `loadEnv.ts` resolves `.env.{APP_ENV}` off `process.cwd()`,
and root-cwd scripts pointing at explicit `packages/*` paths keep that working without any
special-casing.

Cross-package imports (`@pulsecrypto/shared/config`, `@pulsecrypto/shared/binance/client`,
...) resolve two different ways depending on dev vs. prod, which is why `packages/ingestion`
and `packages/broadcast` each carry **two** tsconfigs:
- `tsconfig.json` (used by `tsx watch` and `npm run typecheck:*`) has a `paths` alias
  straight to shared's `src/*.ts` — editing a shared file takes effect immediately, no
  separate shared build/watch needed.
- `tsconfig.build.json` (used by `npm run build:*`) has no such alias; it resolves against
  shared's **compiled** `dist/*.d.ts` instead, via a `paths` entry pointed at
  `../shared/dist/*` — this only works once `npm run build:shared` has run (the root
  `build` script always does this first).

At runtime, the compiled `require("@pulsecrypto/shared/config")` calls resolve through the
npm-workspaces `node_modules/@pulsecrypto/shared` symlink and shared's `package.json`
`exports` map (`"./config": "./dist/config.js"`, etc.) — Node's own resolver honors
`exports` regardless of what TypeScript's `moduleResolution` setting was at compile time,
so this needs no bundler and no `tsconfig-paths`/`tsc-alias` at runtime.

One known limitation: npm workspaces symlinks every package into root `node_modules`
regardless of what's declared in `dependencies`, so nothing at the module-resolution level
literally *prevents* `packages/broadcast` from importing `@pulsecrypto/ingestion` — the
boundary is enforced by each package's declared `dependencies` and code review, not a hard
resolution wall (pnpm's strict linker would add that, out of scope here).

### Key decisions

**Partial book depth stream, not diff-depth + snapshot merge.** Binance offers two ways to
get order book data: (1) `<symbol>@depth20@100ms`, a ready-made top-20-levels snapshot
Binance computes for you, or (2) `<symbol>@depth` diffs that you apply to a REST snapshot
yourself, handling sequence numbers and resyncing on gaps. I chose (1). It's materially
simpler and more robust for this scope, at the cost of only seeing the top 20 levels
instead of the full book. For a market *viewer* (not an execution engine), that trade-off
is easily worth it.

**State, not a queue, is what gets broadcast.** The backend does not buffer a list of
incoming ticks per client. Every Binance message overwrites fields in a `Map<pair, PairState>`
in place. The broadcaster's interval timer just serializes whatever that map currently holds
and sends it. This is what the assignment's buffering requirement ("buffer and/or batch
incoming updates... emit at a configurable interval") maps onto: incoming updates are
naturally "batched" by virtue of overwriting shared state between ticks, so a burst of 50
Binance messages in one 100ms window collapses into exactly one outbound message.

**Backpressure guard is about socket buffers, not app-level queues.** Because there's no
app-level queue, there's nothing there to grow unboundedly. The one place memory actually
could grow is a slow client's outbound TCP socket buffer, if the client (or its network)
can't drain data as fast as we're pushing it. Before each send, the broadcaster checks
`ws.bufferedAmount`; if a client is backlogged past `MAX_CLIENT_BUFFERED_BYTES` (default
1MB), that client is skipped for the current tick rather than having more data queued onto
an already-full buffer. They simply pick up with a fresher snapshot on the next tick.

**Per-client format & cadence, via a control message, not a new endpoint.** A client can send
`{"type":"configure","intervalMs":500,"format":"msgpack"}` over its already-open WebSocket at
any point to switch itself between JSON and msgpack-encoded binary frames, and/or request a
slower broadcast cadence — without reconnecting. Two things are protocol invariants, not
deployment config, so they're constants in `broadcaster.ts` rather than `.env` values:
requested `intervalMs` is clamped to at most 5000ms, and the *effective* interval is always
`max(BROADCAST_INTERVAL_MS, clampedRequest)` — a client can only throttle itself down from the
base tick, never faster, since the base tick is the real ceiling on how fresh the upstream data
is. There's still exactly one global `setInterval` at `BROADCAST_INTERVAL_MS`; per-client cadence
is achieved by gating each client's send within that tick (`now - lastSentAt >= effectiveIntervalMs`)
rather than by running a timer per connection. Malformed or invalid control messages (bad JSON,
unknown `type`, out-of-range `intervalMs`, unrecognized `format`) are logged and ignored — the
connection is never closed over bad input.

**One upstream connection, not one per client.** All mobile clients share a single
Binance WebSocket connection via the shared market store. This is what actually makes the
system scale with client count — Binance connection count and rate limits are decoupled
entirely from how many mobile clients are watching.

**24hr change is polled, not streamed.** Binance's depth stream doesn't carry 24h change
data. Rather than adding a second live stream subscription, `change24h` is refreshed via a
periodic low-frequency REST poll and merged into the same `PairState` the depth stream
updates. This means `change24h` updates roughly every 10s rather than every 100ms — an
acceptable trade-off since 24h change is inherently a slow-moving figure.

**No mock data — honest degradation on Binance REST failure instead.** If the
`/api/v3/ticker/24hr` call fails (rate limiting, network issue, geo-blocking), the backend
never fabricates numbers. Behavior:
- If a previous successful fetch exists, that cached real data keeps being served
  (stale-but-real beats fake-but-fresh), and `change24h` in the market store is simply left
  untouched rather than overwritten with an invented figure.
- If there has never been a successful fetch, `GET /pairs/meta` returns each pair with
  `high24h`/`low24h`/`volume24h` as `null` and `tradingStatus: "UNKNOWN"` — an honest "we
  don't know yet" rather than plausible-looking fake data that could be mistaken for real.
- Every failure is logged server-side, and the most recent error message is exposed via the
  `X-Meta-Fetch-Error` response header on `/pairs/meta`, so callers that care can detect
  degraded data without it changing the response body's shape.

Both paths have been exercised end-to-end during development: the "never fetched
successfully" fallback (confirmed clean nulls/`UNKNOWN` and the header carrying the real
`403` Binance returned when outbound access was blocked, not a swallowed or fabricated
error), and — once outbound access was available in later testing — the live path, with
real Binance data flowing through ingestion → Redis → broadcast → a connected WebSocket
client end-to-end, across every environment/topology change made since.

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

Every previously-hardcoded value that's actually deployment-specific now lives in `.env`
(see `.env.example` for the full list with defaults) — WS path, broadcast interval,
backpressure threshold, tracked pairs, depth levels, Binance WS/REST base URLs, the depth
stream suffix, reconnect backoff schedule, meta poll interval, fetch timeout,
`REDIS_URL` (default `redis://localhost:6379`, overridden to `redis://redis:6379` inside
`docker-compose.yml`'s network), and `APP_MODE` (`distributed` default, or `standalone` —
see Run above). Nothing under `packages/*/src/` hardcodes a URL, port, or timing value
anymore; `packages/shared/src/config.ts` is the single place that reads `process.env`, and
every other module imports from there. Both `packages/ingestion/src/index.ts` and
`packages/broadcast/src/index.ts` read the same `.env`/`config.ts` — only `REDIS_URL`
typically needs to differ between them, and only when they're not on the same Docker
network.

REST responses are gzip-compressed via Express's `compression()` middleware, applied globally
in `packages/broadcast/src/index.ts`. This is transparent to any `fetch`-based client — no request headers or parsing
changes needed. Note `compression`'s default size threshold (~1KB) means `/pairs` and
`/pairs/meta` may legitimately not carry `Content-Encoding: gzip` at the default 5-pair set —
that's the middleware correctly skipping compression that isn't worth the CPU on a payload this
small, not a sign it's misconfigured.

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

Built collaboratively with Claude (Anthropic), used for architectural discussion, code
generation, and in-sandbox verification (dependency install, typecheck, and a live
end-to-end WebSocket smoke test confirming snapshot delivery at the configured interval
and the honest empty-value fallback path when Binance is unreachable — plus the discovery
and fix of a real bug where `.env` was never actually being loaded, since Node doesn't read
`.env` files without an explicit loader).
