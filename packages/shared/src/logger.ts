import { config } from "./config";

/** No-ops unless DEBUG is on. `scope` is a short tag (e.g. "binance", "redis"). */
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

/** Counts a per-tick debug event instead of logging it immediately — avoids flooding the console at market data rates. Flushed as a periodic summary. */
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
