# PulseCrypto — Backend

A Node.js market data gateway between Binance's public WebSocket streams and the PulseCrypto mobile app.

> This is the backend half of PulseCrypto. The mobile app lives in a companion repo,
> **pulsecrypto-mobile**, and expects this service running on `localhost:8080` by default.

## Setup

```bash
cd backend
npm install
cp .env.example .env
```

## Run

```bash
npm run dev      # dev mode, auto-reload via tsx
npm run build    # compile to dist/
npm start        # run compiled build
npm run typecheck
```

Server starts on `http://localhost:8080` by default.

- REST: `GET /health`, `GET /pairs/meta`
- WebSocket: `ws://localhost:8080/ws`

## Architecture

```
Binance combined WS stream (depth20@100ms, 5 pairs)
        │  single persistent connection
        ▼
BinanceIngestionClient  — parses messages, applies to store
        ▼
MarketStore             — in-memory current state per pair (not a queue)
        ▼
Broadcaster              — samples store every BROADCAST_INTERVAL_MS (default 100ms),
                            sends snapshot to every connected client
        ▼
Mobile clients (N)        — WebSocket, one connection each
```

A separate low-frequency poller (`rest/pairsMeta.ts`, default every 10s) hits Binance's
`/api/v3/ticker/24hr` REST endpoint once, and feeds the result into **both** the
`/pairs/meta` cache and the live market store's `change24h` field — one HTTP call serves
both purposes.

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

This was actually exercised during development: this sandbox has no outbound network access
to Binance, so the "never fetched successfully" path is the one verified end-to-end here —
confirmed the response returns clean nulls/`UNKNOWN` and the header carries the real
`403` Binance returned, not a swallowed or fabricated error.

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
stream suffix, reconnect backoff schedule, meta poll interval, and fetch timeout. Nothing
in `src/` hardcodes a URL, port, or timing value anymore; `config.ts` is the single place
that reads `process.env`, and every other module imports from there.

### Display names

Trading-pair display names (`"Bitcoin / Tether"` etc.) live in `src/constants/displayNames.json`
— currently populated with 100 major Binance USDT pairs, not just the 5 actively tracked by
default — and are accessed only through `src/lookup/displayNameLookup.ts`'s `getDisplayName()`
function, never imported directly at call sites. This is deliberate: the plan is to eventually
back this with a MongoDB lookup table, and isolating the data source behind a function means
that migration touches one file instead of a find-and-replace across the codebase. That said,
the interface will need to become `async` when that happens (a DB call can't be synchronous),
which will ripple into the (currently synchronous) loops in `rest/pairsMeta.ts` — flagged with
a `TODO(mongo-migration)` comment at the point it'll need touching, rather than pre-emptively
making everything async today for a backend that doesn't exist yet.

Note the distinction: this table only affects display names. Which pairs the backend actually
*connects to Binance for and streams live data on* is controlled separately by `PAIRS` in
`.env` (5 by default). `getDisplayName()` gracefully falls back to the raw symbol for any pair
not in the table, so the two lists are safe to keep out of sync — e.g. `PAIRS=btcusdt,apeusdt`
resolves cleanly today even though only `BTCUSDT` was in the table when this project started.

## Trade-offs not taken further (given scope)

- No Redis/pub-sub layer for horizontal scaling across multiple backend instances — not
  needed at this scale, but the ingestion/state/broadcast separation is structured so that
  swapping the in-memory `MarketStore` for a Redis-backed one wouldn't require touching the
  ingestion or broadcast layers.
- No historical price storage/candles — out of scope per the spec (current price + book only).

## AI-assisted development

Built collaboratively with Claude (Anthropic), used for architectural discussion, code
generation, and in-sandbox verification (dependency install, typecheck, and a live
end-to-end WebSocket smoke test confirming snapshot delivery at the configured interval
and the honest empty-value fallback path when Binance is unreachable — plus the discovery
and fix of a real bug where `.env` was never actually being loaded, since Node doesn't read
`.env` files without an explicit loader).
