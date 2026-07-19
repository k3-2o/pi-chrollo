// --- Chrollo Injection Dedup + Gating (AD-10, Phase 10A) ---
//
// Pure helpers for auto-injection. Kept separate from index.ts (wiring) and
// search.ts (retrieval) so they're unit-testable without the Pi lifecycle harness.
//
// Three concerns:
//   1. Trivial-prompt gating (Phase 10A) — skip the search entirely for
//      acknowledgements / greetings / continuations. No content worth recalling.
//   2. Topic-change detection — if a prompt shares NO distinctive term with the
//      previous one, treat it as a new topic and clear the injected-key set.
//   3. Seen-key filtering — drop results whose `sourcePath:line` we already
//      surfaced on a prior turn of the same topic.

export interface HasKey {
  sourcePath: string;
  line: number;
}

export function dedupKey(r: HasKey): string {
  return `${r.sourcePath}:${r.line}`;
}

// --- Trivial-prompt gate (Phase 10A). True when the prompt carries no content
//     worth a memory search: pure acknowledgements, greetings, thanks, or
//     continuations. Zero-LLM lexical check. Skipping the proximity search on
//     these avoids blowing the 50ms injection budget on prompts that would
//     return nothing useful anyway.
//
//     A prompt is trivial when, after lowercasing + splitting on whitespace,
//     EVERY non-empty token is in the TRIVIAL set (acknowledgements/greetings/
//     thanks/continuations/evaluations). One real word -> not trivial.
const TRIVIAL_TOKENS = new Set([
  // acknowledgements
  "yes",
  "yep",
  "yeah",
  "yup",
  "no",
  "nope",
  "nah",
  "ok",
  "okay",
  "k",
  "sure",
  "right",
  "exactly",
  "correct",
  "gotcha",
  "understood",
  "acknowledged",
  "agreed",
  // greetings
  "hi",
  "hello",
  "hey",
  "yo",
  "sup",
  "howdy",
  // thanks
  "thanks",
  "thank",
  "thx",
  "appreciate",
  "cheers",
  // continuation / control
  "continue",
  "go",
  "proceed",
  "next",
  "more",
  "again",
  "keep",
  "onward",
  "ahead",
  // evaluation (no searchable content)
  "cool",
  "nice",
  "great",
  "good",
  "perfect",
  "awesome",
  "sweet",
  "fine",
  "wow",
  "sounds",
  "looks",
  "seems",
  // filler words that pair with trivial words ("thank you", "keep going", "sounds good")
  "you",
  "going",
  "it",
  "was",
  "that",
  "so",
  "very",
  "really",
  "much",
  // punctuation / filler
  "please",
  "hmm",
  "lol",
  "haha",
]);

export function isTrivialPrompt(prompt: string): boolean {
  const tokens = prompt
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  return tokens.every((t) => TRIVIAL_TOKENS.has(t));
}

// --- Are two term sets identical? (Phase 10A Gate 2) Used to skip the proximity
//     search when the distinctive terms haven't changed since the last injection:
//     same terms -> same rg query -> same results -> dedup would filter them all.
//     Saves the 50ms budget. If even one term differs, there might be new matches,
//     so re-search. (Not a subset check — a single new term is enough to re-search.)
export function sameTerms(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
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

// --- Decide whether to run the ambient (auto-injection) proximity search for
//     this prompt. Pure: returns the new state + a skip flag. Kept in this
//     module so it can be unit-tested without the Pi lifecycle harness.
export interface AmbientSearchDecision {
  skip: boolean;
  injectedKeys: Set<string>;
  lastDistinctTerms: Set<string>;
}

export function decideAmbientSearch(
  distinctTerms: string[],
  lastDistinctTerms: Set<string>,
  injectedKeys: Set<string>,
): AmbientSearchDecision {
  const currentTerms = new Set(distinctTerms);

  // Topic-change reset (AD-10): if this prompt shares NO distinctive term with
  // the previous one, treat it as a new topic and clear the injected-key set.
  const nextKeys = topicChanged(lastDistinctTerms, currentTerms) ? new Set<string>() : injectedKeys;

  // --- GATE 2 (Phase 10A): identical terms + already injected -> skip.
  //     Same distinctive terms means the same rg query -> same results ->
  //     dedup would filter them all anyway. If even one term changed (a new
  //     sub-question on the same topic), re-search — there might be new matches.
  const skip = nextKeys.size > 0 && sameTerms(lastDistinctTerms, currentTerms);
  const updatedLastDistinctTerms = currentTerms;

  return { skip, injectedKeys: nextKeys, lastDistinctTerms: updatedLastDistinctTerms };
}
