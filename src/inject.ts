// Chrollo Injection Dedup + Gating (AD-10, Phase 10A). Pure helpers for
// auto-injection — unit-testable without the Pi lifecycle harness.

export interface HasKey {
  sourcePath: string;
  line: number;
}

export function dedupKey(r: HasKey): string {
  return `${r.sourcePath}:${r.line}`;
}

// Trivial-prompt gate (Phase 10A): zero-LLM lexical check for acknowledgements,
// greetings, thanks, continuations — skip the proximity search when the prompt
// carries no searchable content, saving the 50ms budget for prompts that need it.
// A prompt is trivial when EVERY lowercased token is in TRIVIAL_TOKENS.
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

// Are two term sets identical? (Phase 10A Gate 2) — same terms = same rg
// query = same results dedup'd away, so skip the search and save the budget.
// One new term is enough to re-search.
export function sameTerms(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

// Topic changed? True when prev and curr share NO distinctive term (both non-empty).
export function topicChanged(prev: Set<string>, curr: Set<string>): boolean {
  if (prev.size === 0 || curr.size === 0) return false;
  for (const t of curr) {
    if (prev.has(t)) return false;
  }
  return true;
}

// Drop results whose file:line key is already in injectedKeys (original order). Pure.
export function filterInjected<T extends HasKey>(results: T[], injectedKeys: Set<string>): T[] {
  return results.filter((r) => !injectedKeys.has(dedupKey(r)));
}

// Run fn with a hard timeout. If the 50ms budget is exceeded, abort signal fires
// and after fn resolves we check signal.aborted — enforcing the budget even for
// post-search synchronous work. Timer cleared in finally (no lingering timer).
export async function withInjectionBudget<T>(
  budgetMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const result = await fn(controller.signal);
    if (controller.signal.aborted) throw new Error("read_memory: aborted");
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// Record freshly-injected keys into the set (mutates set).
export function recordInjected<T extends HasKey>(results: T[], injectedKeys: Set<string>): void {
  for (const r of results) injectedKeys.add(dedupKey(r));
}

// Decide whether to run ambient search. Pure function: takes state, returns new
// state + skip flag. Unit-testable without Pi lifecycle harness.
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

  // Topic-change reset: if this prompt shares NO term with the previous one,
  // treat as new topic and clear the injected-key set.
  const nextKeys = topicChanged(lastDistinctTerms, currentTerms) ? new Set<string>() : injectedKeys;

  // GATE 2: identical terms + already injected -> skip (same rg -> same results -> dedup'd away)
  const skip = nextKeys.size > 0 && sameTerms(lastDistinctTerms, currentTerms);
  const updatedLastDistinctTerms = currentTerms;

  return { skip, injectedKeys: nextKeys, lastDistinctTerms: updatedLastDistinctTerms };
}
