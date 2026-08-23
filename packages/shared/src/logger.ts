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
