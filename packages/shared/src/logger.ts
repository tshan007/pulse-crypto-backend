import { config } from "./config";

/**
 * No-ops unless DEBUG is on (config.debug — see the :debug script aliases in
 * package.json). Scope is a short tag identifying where the log came from
 * (e.g. "binance", "redis", "broadcast"), matching the existing `[server]`/
 * `[binance]`/etc. bracket convention used by the always-on console.log calls.
 */
export function debugLog(scope: string, ...args: unknown[]): void {
  if (!config.debug) return;
  console.log(`[debug:${scope}]`, ...args);
}

const TICK_SUMMARY_INTERVAL_MS = 5000;

interface TickEntry {
  scope: string;
  label: string;
  count: number;
  pairs: Set<string>;
}

const tickEntries = new Map<string, TickEntry>();
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Counts a high-frequency per-tick debug event (one per price update) instead of
 * logging it immediately — at market data rates (100 pairs, sub-second ticks),
 * one debugLog() call per tick floods the console. Flushed as a periodic summary
 * every TICK_SUMMARY_INTERVAL_MS by flushTickSummaries().
 */
export function debugTick(scope: string, label: string, pair: string): void {
  if (!config.debug) return;
  const key = `${scope}/${label}`;
  let entry = tickEntries.get(key);
  if (!entry) {
    entry = { scope, label, count: 0, pairs: new Set() };
    tickEntries.set(key, entry);
  }
  entry.count += 1;
  entry.pairs.add(pair);

  if (!flushTimer) {
    flushTimer = setInterval(flushTickSummaries, TICK_SUMMARY_INTERVAL_MS);
    flushTimer.unref();
  }
}

function flushTickSummaries(): void {
  const seconds = TICK_SUMMARY_INTERVAL_MS / 1000;
  for (const entry of tickEntries.values()) {
    if (entry.count === 0) continue;
    console.log(
      `[debug:${entry.scope}] ${entry.label}: ${entry.count} updates across ${entry.pairs.size} pairs (last ${seconds}s)`
    );
    entry.count = 0;
    entry.pairs.clear();
  }
}
