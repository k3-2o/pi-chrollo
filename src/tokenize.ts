// Chrollo query processing — tokenization, light stemming, typo fallback,
// and distinctive-term extraction. Pure functions: no I/O, no state.
// Feeds both the rg query construction (search.ts) and candidate tokenization
// (rank.ts / bm25.ts).

// Stopwords trimmed (no "remember", "talked", "thing" etc — those carry signal).
export const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "about",
  "up",
  "down",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "myself",
  "we",
  "our",
  "ours",
  "ourselves",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "he",
  "him",
  "his",
  "himself",
  "she",
  "her",
  "hers",
  "herself",
  "it",
  "its",
  "itself",
  "they",
  "them",
  "their",
  "theirs",
  "themselves",
  "also",
  "get",
  "got",
  "like",
  "know",
  "think",
  "want",
  "look",
  "use",
  "find",
  "give",
  "tell",
  "say",
  "said",
  "take",
  "come",
  "make",
  "go",
  "see",
]);

// Split code identifiers (camelCase / snake_case / kebab / acronyms), lowercase,
// drop fragments ≤ 2 chars. Splitting identifiers recovers recall
// (optimizeRerenders → optimize + rerenders).
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // getUserProfile -> get UserProfile
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTTPServer -> HTTP Server
    .replace(/[_-]+/g, " ") // user_profile, kebab-case -> spaces
    .replace(/[^\w\s]/g, " ") // strip remaining punctuation
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

const STEM_SUFFIXES = ["ment", "ion", "ing", "ed", "er", "es", "s"];

// Light stemming: strip ONE common suffix from words > 4 chars, keep root ≥ 3.
// ripgrep -F matches substrings, so grepping the stem catches all inflections
// (deployment -> deploy matches deploy/deploys/deploying/deployed).
// Trade-off: "er" occasionally over-matches (docker -> dock), mitigated by
// corpus-frequency rarity filter downstream.
export function stem(word: string): string {
  if (word.length <= 4) return word; // too short to stem safely
  for (const suf of STEM_SUFFIXES) {
    if (word.endsWith(suf)) {
      const root = word.slice(0, word.length - suf.length);
      if (root.length >= 3) return root; // don't over-stem to a fragment
      break; // suffix found but root too short -> keep original
    }
  }
  return word;
}

// Expand term into [term, stem] when stemming changes it (rg group-level OR).
export function groupWithStem(term: string): string[] {
  const s = stem(term);
  return s !== term ? [term, s] : [term];
}

// Trigram typo fallback: split term into 3-char trigrams and OR them as regex.
// Catches typos (recieve <-> receive share 'rec' and 'ive') and partial
// spellings without embeddings. Returns null when the term is too short to
// yield ≥ 2 distinct trigrams.
export function trigramRegex(term: string): string | null {
  if (term.length < 4) return null;
  const trigrams: string[] = [];
  for (let i = 0; i + 3 <= term.length; i++) {
    trigrams.push(term.slice(i, i + 3));
  }
  const uniq = [...new Set(trigrams)];
  if (uniq.length < 2) return null;
  return `(${uniq.join("|")})`;
}

// Extract the query's content words: lowercase, non-stopword. The old version
// filtered by corpus rarity (appearing in < 30% of docs) — that required the
// global dictionary that caused the 13s freeze and is permanently gone (SPEC
// §3.3). The user already chose which words matter by typing them; we just drop
// stopwords and bound the pattern count for ripgrep.
export function queryTerms(query: string): string[] {
  return tokenize(query)
    .filter((w) => !STOP_WORDS.has(w))
    .slice(0, 8);
}
