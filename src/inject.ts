// --- Chrollo Injection Dedup (AD-10) ---
//
// Pure helpers for auto-injection de-duplication. Kept separate from index.ts
// (wiring) and search.ts (retrieval) so they're unit-testable without the Pi
// lifecycle harness.
//
// Two concerns:
//   1. Topic-change detection — if a prompt shares NO distinctive term with the
//      previous one, treat it as a new topic and clear the injected-key set.
//      Cosine-free (no embeddings): plain set intersection.
//   2. Seen-key filtering — drop results whose `sourcePath:line` we already
//      surfaced on a prior turn of the same topic.

export interface HasKey {
  sourcePath: string;
  line: number;
}

export function dedupKey(r: HasKey): string {
  return `${r.sourcePath}:${r.line}`;
}

// --- Did the topic change? True when prev and curr share NO distinctive term.
//     Either side empty → treat as "no prior topic" → NOT a change (keep set).
//     (Empty curr shouldn't happen — caller guards on length>=2 — but defensive.)
export function topicChanged(prev: Set<string>, curr: Set<string>): boolean {
  if (prev.size === 0 || curr.size === 0) return false;
  for (const t of curr) {
    if (prev.has(t)) return false;
  }
  return true;
}

// --- Drop results whose key is already in injectedKeys. Returns the fresh ones
//     in original order. Pure: does not mutate inputs.
export function filterInjected<T extends HasKey>(results: T[], injectedKeys: Set<string>): T[] {
  return results.filter((r) => !injectedKeys.has(dedupKey(r)));
}

// --- Record the keys of freshly-injected results into the set (mutates set).
export function recordInjected<T extends HasKey>(results: T[], injectedKeys: Set<string>): void {
  for (const r of results) injectedKeys.add(dedupKey(r));
}
