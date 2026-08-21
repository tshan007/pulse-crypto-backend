import displayNamesData from "../constants/displayNames.json";

/**
 * Looks up the human-readable display name for a trading pair symbol.
 *
 * Currently backed by a static JSON constant file (constants/displayNames.json).
 * This is intentionally isolated behind a function rather than importing the
 * JSON directly at every call site — when this becomes a MongoDB-backed
 * lookup table, only this file changes.
 *
 * TODO(mongo-migration): replace the body with something like
 *   `const doc = await db.collection("pairs").findOne({ symbol: pair });`
 *   `return doc?.displayName ?? pair;`
 * Note that becomes async — call sites (currently synchronous loops in
 * rest/pairsMeta.ts) will need `await` and, if looking up many pairs at
 * once, a batched query (`find({ symbol: { $in: pairs } })`) rather than
 * one round-trip per pair.
 */
const displayNames: Record<string, string> = displayNamesData;

export function getDisplayName(pair: string): string {
  return displayNames[pair] ?? pair;
}
