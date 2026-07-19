// --- Chrollo Search Layer ---

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMemoriesDir } from "./storage.js";
import { recordMetric } from "./metrics.js";
import { getAccessMap, recordAccess } from "./access.js";

const execFileAsync = promisify(execFile);

export interface CompactResult {
  text: string;
  source: string;
  sourcePath: string; // full path for agent (read <path> --offset <N>)
  line: number;
  matchedTerms: string[];
  lineDate?: Date; // per-line timestamp, parsed from [YYYY-MM-DD HH:MM:SS]
}

export interface SearchResponse {
  results: CompactResult[];
  layer: "and" | "proximity" | "trigram";
  totalMatches: number;
}

const MAX_RESULTS = 20;
const PER_FILE_CAP = 3; // PER_FILE_CAP: max 3 per session for diversity (AD-9)
const RECENCY_BOOST = 1.0;
const RECENCY_HALF_LIFE_DAYS = 30;
// lambda = HALF_LIFE / ln(2) so exp(-days/lambda) = 0.5 at half-life
const RECENCY_LAMBDA = RECENCY_HALF_LIFE_DAYS / Math.LN2;
const PROXIMITY_WINDOW = 20; // default window lines for proximity search

// Stopwords — trimmed (no "remember", "talked", "thing" etc)

const STOP_WORDS = new Set([
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

// --- Tokenize ---

// Tokenize: split code identifiers (camelCase / snake_case / kebab / acronyms),
// lowercase, drop fragments <= 2 chars. Splitting identifiers recovers recall
// (optimizeRerenders -> optimize + renders).
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

// --- Light stemming (AD-11) ---

// Light stemming: strip ONE common suffix from words > 4 chars, keep root >= 3.
// ripgrep -F matches substrings, so grepping the stem catches all inflections
// (deployment -> deploy matches deploy/deploys/deploying/deployed).
// Partially offsets the recall lost when thesaurus was removed (AD-7).
// Trade-off: "er" occasionally over-matches (docker -> dock), mitigated by
// corpus-frequency rarity filter.
const STEM_SUFFIXES = ["ment", "ion", "ing", "ed", "er", "es", "s"];
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

// Expand term into [term, stem] when stemming changes it (AND uses group-level OR).
export function groupWithStem(term: string): string[] {
  const s = stem(term);
  return s !== term ? [term, s] : [term];
}

// Trigram typo fallback (AD-12): as last resort, split term into 3-char trigrams
// and OR them as regex. Catches typos (recieve<->receive share 'rec' and 'ive')
// and partial spellings without embeddings. Fires on AND-miss, terms >= 4 chars.
export function trigramRegex(term: string): string | null {
  if (term.length < 4) return null;
  const trigrams: string[] = [];
  for (let i = 0; i + 3 <= term.length; i++) {
    trigrams.push(term.slice(i, i + 3));
  }
  // dedup + need at least 2 to be meaningful
  const uniq = [...new Set(trigrams)];
  if (uniq.length < 2) return null;
  return `(${uniq.join("|")})`;
}

// Last-resort trigram OR across all query terms (OR of all trigram regexes).
// Results flagged layer 'trigram'.
async function trigramFallback(
  terms: string[],
  signal?: AbortSignal,
  idfWeights?: Map<string, number>,
): Promise<SearchResponse> {
  const dir = getMemoriesDir();
  if (!fs.existsSync(dir)) return { results: [], layer: "trigram", totalMatches: 0 };

  // Build combined alternation from every term's trigrams (OR across all).
  const allPatterns: string[] = [];
  for (const t of terms) {
    const r = trigramRegex(t);
    if (r !== null) allPatterns.push(r);
  }
  if (allPatterns.length === 0) return { results: [], layer: "trigram", totalMatches: 0 };
  const combined = allPatterns.join("|");

  let stdout: string;
  try {
    const res = await execFileAsync(
      // NOTE: no -F (this is a regex, not a fixed string)
      "rg",
      ["--json", "-n", "-i", "-e", combined, "--", dir],
      { signal, timeout: 3000, maxBuffer: 5 * 1024 * 1024 },
    );
    stdout = res.stdout;
  } catch {
    return { results: [], layer: "trigram", totalMatches: 0 };
  }

  const results: CompactResult[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type !== "match") continue;
    const text = (ev.data.lines.text as string).replace(/\n$/, "");
    results.push({
      text,
      source: path.basename(ev.data.path.text),
      sourcePath: ev.data.path.text,
      line: ev.data.line_number as number,
      matchedTerms: (ev.data.submatches as Array<{ match: { text: string } }>).map((s) =>
        s.match.text.toLowerCase(),
      ),
      lineDate: parseLineDate(text),
    });
  }

  const clean = results.filter((r) => !isToolLine(r.text));
  const ranked = rankResults(clean, { accessMap: getAccessMap(), idfWeights });
  recordAccess(ranked.map((r) => `${r.sourcePath}:${r.line}`));
  return { results: ranked, layer: "trigram", totalMatches: clean.length };
}

// Parse memory filename's date as LOCAL — not UTC (storage.ts uses local date,
// so "Z" would skew recency for users ahead of UTC).
export function parseFileDate(filename: string): Date | undefined {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})_\d{6}_[a-f0-9]+\.md$/);
  if (m === null) return undefined;
  const dt = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  return isNaN(dt.getTime()) ? undefined : dt;
}

// Parse [YYYY-MM-DD HH:MM:SS] line timestamp as LOCAL (same reason as parseFileDate).
export function parseLineDate(line: string): Date | undefined {
  const m = line.match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/);
  if (m === null) return undefined;
  const dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(dt.getTime()) ? undefined : dt;
}

// Recency multiplier: 30-day half-life exponential decay. today=2.0x,
// week~1.85x, 3mo~1.13x, year~1.0x.
export function recencyMultiplier(lineDate: Date | undefined, lastAccessed?: Date): number {
  if (lineDate === undefined) return 1.0;
  const now = Date.now();
  const daysSince = (now - lineDate.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < 0) return 1.0; // future-dated: no boost, no penalty

  let decay = Math.exp(-daysSince / RECENCY_LAMBDA);

  // Access reinforcement (Phase 10B): blend in access freshness at 70% strength.
  // A memory you keep coming back to stays accessible longer than one you
  // wrote once and forgot.
  if (lastAccessed !== undefined) {
    const daysSinceAccess = (now - lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceAccess >= 0) {
      const accessDecay = Math.exp(-daysSinceAccess / RECENCY_LAMBDA) * 0.7;
      decay = Math.max(decay, accessDecay);
    }
  }

  return 1 + RECENCY_BOOST * decay;
}

// --- Corpus word frequency (for filtering common words) ---
// Synchronous, computed once per session (pre-warmed at session_start into a
// closure var in index.ts, reused for every prompt). Module-level cache cleared
// at session_shutdown. This is deliberately SYNCHRONOUS: the handlers must run
// atomically (no mid-handler yields) so the cache is always warm when the
// prompt path reads it. The once-per-session ~280ms read at startup is
// acceptable; it is NOT per-prompt. (The async conversion of this function in
// 0.2.0 broke atomicity and froze the prompt box — reverted.)

let _corpusFreqCache: Map<string, number> | null = null;
let _corpusTotalFiles = 0;

export function computeCorpusFrequency(): { freq: Map<string, number>; totalFiles: number } {
  if (_corpusFreqCache !== null) {
    return { freq: _corpusFreqCache, totalFiles: _corpusTotalFiles };
  }

  const dir = getMemoriesDir();
  if (!fs.existsSync(dir)) {
    _corpusFreqCache = new Map();
    _corpusTotalFiles = 0;
    return { freq: _corpusFreqCache, totalFiles: 0 };
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  const freq = new Map<string, number>();

  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), "utf-8");
    const words = new Set(tokenize(content));
    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  _corpusFreqCache = freq;
  _corpusTotalFiles = files.length;
  return { freq, totalFiles: files.length };
}

// --- Drop the in-memory cache. Called at session_shutdown so the next session
//     rebuilds (picks up files written by other sessions / imports). ---
export function invalidateCorpusCache(): void {
  _corpusFreqCache = null;
  _corpusTotalFiles = 0;
}

// --- Smart term extraction: 5 max, filtered by corpus frequency ---

export function extractDistinctiveTerms(
  query: string,
  corpusFreq: Map<string, number>,
  totalFiles: number,
): string[] {
  const raw = tokenize(query).filter((w) => !STOP_WORDS.has(w));

  if (raw.length === 0) return [];

  // Score each word: lower corpus frequency = more distinctive
  const scored = raw.map((w) => ({
    word: w,
    freqRatio: totalFiles > 0 ? (corpusFreq.get(w) ?? 0) / totalFiles : 0,
  }));

  // Sort by rarity (least frequent first = most distinctive)
  scored.sort((a, b) => a.freqRatio - b.freqRatio);

  // Take top 5 that appear in less than 30% of files
  const filtered = scored
    .filter((s) => s.freqRatio < 0.3)
    .slice(0, 5)
    .map((s) => s.word);

  // If filter removed everything, fall back to raw query terms
  if (filtered.length === 0 && raw.length > 0) {
    return raw.slice(0, 3);
  }

  return filtered;
}

// --- Single-pass AND search (AD-4) ---
// One `rg --json` call for ALL terms (matches any term), then compute the
// file-level AND in JS: keep only files whose matched-term set covers every
// query term. The same pass yields the matching lines for free, so there is
// no separate line-fetch step. Replaces the old N-serial-`rg -l` + second
// `rg --json` (which spawned N+1 processes and blew the 50ms inject budget).
export async function singlePassAndSearch(
  terms: string[],
  signal?: AbortSignal,
): Promise<{ files: string[]; lines: CompactResult[] }> {
  const dir = getMemoriesDir();
  if (!fs.existsSync(dir) || terms.length === 0) {
    return { files: [], lines: [] };
  }

  // Expand each term into a [term, stem] group (AD-11). ripgrep -F matches
  // substrings, so grepping a stem catches all its inflections. AND is now
  // group-level: every GROUP must be matched (any literal in it), not every
  // literal.
  const groups = terms.map(groupWithStem);
  const patterns = groups.flat();

  const termFlags: string[] = [];
  for (const p of patterns) termFlags.push("-e", p);
  // Map each lowercased literal -> the group indices it can satisfy.
  const literalToGroups = new Map<string, Set<number>>();
  groups.forEach((g, gi) => {
    for (const lit of g) {
      const k = lit.toLowerCase();
      if (!literalToGroups.has(k)) literalToGroups.set(k, new Set());
      literalToGroups.get(k)!.add(gi);
    }
  });

  let stdout: string;
  try {
    const res = await execFileAsync("rg", ["--json", "-n", "-F", "-i", ...termFlags, "--", dir], {
      signal,
      timeout: 3000,
      maxBuffer: 5 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch {
    // rg exits 1 when no match at all → AND yields nothing.
    return { files: [], lines: [] };
  }

  // Per file: which GROUPS matched (not literals), and all matching lines.
  const fileGroups = new Map<string, Set<number>>();
  const allLines: CompactResult[] = [];

  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type !== "match") continue;

    const filePath: string = ev.data.path.text;
    const text: string = (ev.data.lines.text as string).replace(/\n$/, "");
    const matchedHere = (ev.data.submatches as Array<{ match: { text: string } }>).map((s) =>
      s.match.text.toLowerCase(),
    );

    if (!fileGroups.has(filePath)) fileGroups.set(filePath, new Set());
    const bucket = fileGroups.get(filePath)!;
    for (const t of matchedHere) {
      const gis = literalToGroups.get(t);
      if (gis !== undefined) for (const gi of gis) bucket.add(gi);
    }

    allLines.push({
      text,
      source: path.basename(filePath),
      sourcePath: filePath,
      line: ev.data.line_number as number,
      matchedTerms: matchedHere,
      lineDate: parseLineDate(text),
    });
  }

  // File-level AND (group-aware): keep only files where EVERY group is
  // satisfied by at least one matched literal.
  const andFiles: string[] = [];
  for (const [file, coveredGroups] of fileGroups) {
    if (groups.every((_, gi) => coveredGroups.has(gi))) andFiles.push(file);
  }
  if (andFiles.length === 0) return { files: [], lines: [] };

  // Keep only lines from AND-passing files, drop tool-call lines.
  const andFileSet = new Set(andFiles);
  const lines = allLines
    .filter((r) => andFileSet.has(r.sourcePath))
    .filter((r) => !isToolLine(r.text));

  return { files: andFiles, lines };
}

// --- Filter tool-call lines from search results ---
// formatToolCall wraps every tool invocation in <tool>...</tool>,
// making them trivially distinguishable from prose.
// New captures use this marker. Existing pre-migration files use
// heuristic fallbacks that are safe (path-based, never natural language).
function isToolLine(text: string): boolean {
  // Primary: <tool> marker set by formatToolCall (covers all tools)
  if (/^>\s*<tool>/.test(text)) return true;

  // Fallback heuristics for pre-migration files (will be removed once old files are cleaned)
  return (
    /^>\s+\$\s/.test(text) || // > $ command
    /^>\s+read_memory\s/.test(text) || // > read_memory query
    /^>\s+grep\s/.test(text) || // > grep
    /^>\s+ls\s/.test(text) || // > ls
    /^>\s+(read|edit|write|find)\s+(\/|\.\/|~\/|\w+\/)/.test(text) || // with path
    /^>\s+read\s+\w+\.\w+/.test(text) || // read filename.ext
    /^>\s+(edit|write)\s+\w+\.\w+/.test(text) || // edit/write filename.ext
    /^>\s+[a-z][a-zA-Z0-9_]*_\w+\s/.test(text) // underscore tool names (composio_*)
  );
}

export interface RankContext {
  accessMap?: Map<string, Date>;
  idfWeights?: Map<string, number>;
}

// IDF weights: rare terms get high weight, common terms get low. Used by
// rankResults so a match on 'k3s' (rare) outranks 'config' (common) at equal
// distinct-term count.
export function buildIdfWeights(
  terms: string[],
  freq: Map<string, number>,
  totalFiles: number,
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const term of terms) {
    const f = freq.get(term) ?? 0;
    const idf = Math.log(1 + totalFiles / (1 + f));
    weights.set(term, idf);
    const s = stem(term);
    if (s !== term) weights.set(s, idf); // stem shares the term's weight
  }
  return weights;
}

// Score result: IDF-weighted distinct terms × recency.
function scoreResult(r: CompactResult, ctx: RankContext | undefined, key: string): number {
  const distinct = new Set(r.matchedTerms);
  let termScore: number;
  if (ctx?.idfWeights !== undefined && ctx.idfWeights.size > 0) {
    termScore = 0;
    for (const t of distinct) termScore += ctx.idfWeights.get(t) ?? 1;
  } else {
    termScore = distinct.size;
  }
  return termScore * recencyMultiplier(r.lineDate, ctx?.accessMap?.get(key));
}

export function rankResults(results: CompactResult[], ctx?: RankContext): CompactResult[] {
  // Dedup by file:line
  const seen = new Set<string>();
  const unique: CompactResult[] = [];
  for (const r of results) {
    const key = `${r.sourcePath}:${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  // Sort: IDF-weighted term score × recency (IDF weights optional — falls back to distinct-term count). Access history reinforces recency (Phase 10B).
  unique.sort((a, b) => {
    const aKey = `${a.sourcePath}:${a.line}`;
    const bKey = `${b.sourcePath}:${b.line}`;
    const aScore = scoreResult(a, ctx, aKey);
    const bScore = scoreResult(b, ctx, bKey);
    return bScore - aScore;
  });

  // Diversity (AD-9): max PER_FILE_CAP per source file so one long session
  // doesn't drown out matches spread across others.
  const perFile = new Map<string, number>();
  const capped: CompactResult[] = [];
  for (const r of unique) {
    const count = perFile.get(r.sourcePath) ?? 0;
    if (count >= PER_FILE_CAP) continue;
    perFile.set(r.sourcePath, count + 1);
    capped.push(r);
    if (capped.length >= MAX_RESULTS) break;
  }
  return capped;
}

// --- Public API ---

// AND search: all extracted terms must appear in the same file.
// On AND-miss, falls back to trigram typo search (AD-12).
export async function grepSearch(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  const started = Date.now();
  const track = (res: SearchResponse): SearchResponse => {
    recordMetric({
      kind: "search",
      latencyMs: Date.now() - started,
      resultCount: res.results.length,
      aborted: signal?.aborted === true,
    });
    return res;
  };

  if (signal?.aborted) throw new Error("read_memory: aborted");

  const { freq, totalFiles } = computeCorpusFrequency();
  const terms = extractDistinctiveTerms(query, freq, totalFiles);
  const idfWeights = buildIdfWeights(terms, freq, totalFiles);

  if (terms.length === 0) {
    return track({ results: [], layer: "and", totalMatches: 0 });
  }

  // Step 1: single-pass AND — one rg call, file-level AND in JS
  const { files: andFiles, lines: andLines } = await singlePassAndSearch(terms, signal);
  if (signal?.aborted) throw new Error("read_memory: aborted");

  if (andFiles.length > 0) {
    const ranked = rankResults(andLines, { accessMap: getAccessMap(), idfWeights });
    recordAccess(ranked.map((r) => `${r.sourcePath}:${r.line}`));
    return track({ results: ranked, layer: "and", totalMatches: andLines.length });
  }

  // AND-miss: trigram typo fallback (AD-12) — loosens to OR across 3-char sub-patterns
  if (signal?.aborted) throw new Error("read_memory: aborted");
  return track(await trigramFallback(terms, signal, idfWeights));
}

// Proximity search: terms must appear within N lines of each other.
// Used for auto-injection — finds conceptually dense passages.
export async function proximitySearch(
  terms: string[],
  windowLines: number = PROXIMITY_WINDOW,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const started = Date.now();
  const track = (res: SearchResponse): SearchResponse => {
    recordMetric({
      kind: "inject",
      latencyMs: Date.now() - started,
      resultCount: res.results.length,
      aborted: signal?.aborted === true,
    });
    return res;
  };

  const dir = getMemoriesDir();
  if (!fs.existsSync(dir) || terms.length < 2) {
    return track({ results: [], layer: "proximity", totalMatches: 0 });
  }

  // rg with context window around each match, then check term proximity in JS
  const termFlags: string[] = [];
  for (const term of terms) {
    termFlags.push("-e", term);
  }

  let rgStdout: string;
  try {
    const ctxLines = Math.ceil(windowLines / 2);
    const { stdout } = await execFileAsync(
      "rg",
      ["--json", "-n", "-F", "-i", "-C", String(ctxLines), ...termFlags, dir],
      { signal, timeout: 3000, maxBuffer: 5 * 1024 * 1024 },
    );
    rgStdout = stdout;
  } catch {
    // rg throws on abort (50ms budget) or no-match. Record + return empty.
    return track({ results: [], layer: "proximity", totalMatches: 0 });
  }

  if (signal?.aborted) throw new Error("read_memory: aborted");

  // Parse JSON events, group by file
  const events: Array<{ type: string; data: any }> = [];
  for (const raw of rgStdout.trim().split("\n")) {
    try {
      events.push(JSON.parse(raw));
    } catch {
      // skip malformed
    }
  }

  // Group match events by file
  const fileMatches = new Map<string, Array<{ line: number; term: string; text: string }>>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.type !== "match") continue;

    const filePath = ev.data.path.text as string;
    const lineNum = ev.data.line_number as number;
    const text = (ev.data.lines.text as string).replace(/\n$/, "");

    if (!fileMatches.has(filePath)) fileMatches.set(filePath, []);
    for (const sm of ev.data.submatches as Array<{ match: { text: string } }>) {
      fileMatches.get(filePath)!.push({
        line: lineNum,
        term: sm.match.text.toLowerCase(),
        text,
      });
    }
  }

  // For each file, check if distinct terms appear within windowLines
  const proximityResults: CompactResult[] = [];
  for (const [filePath, matches] of fileMatches) {
    // Group matches by line (dedup)
    const byLine = new Map<number, { text: string; terms: Set<string> }>();
    for (const m of matches) {
      if (!byLine.has(m.line)) byLine.set(m.line, { text: m.text, terms: new Set() });
      byLine.get(m.line)!.terms.add(m.term);
    }

    const lineEntries = [...byLine.entries()].sort((a, b) => a[0] - b[0]);

    // Sliding window: check each group of lines within windowLines
    for (let i = 0; i < lineEntries.length; i++) {
      const seenTerms = new Set(lineEntries[i][1].terms);
      let end = i;

      while (
        end + 1 < lineEntries.length &&
        lineEntries[end + 1][0] - lineEntries[i][0] <= windowLines
      ) {
        end++;
        for (const t of lineEntries[end][1].terms) seenTerms.add(t);
      }

      // Check if at least 2 distinct original terms appear in this window
      const origTermsInWindow = terms.filter((t) => seenTerms.has(t));
      if (origTermsInWindow.length >= 2) {
        // Pick the first line in the cluster
        const first = lineEntries[i][1];
        proximityResults.push({
          text: first.text,
          source: path.basename(filePath),
          sourcePath: filePath,
          line: lineEntries[i][0],
          matchedTerms: origTermsInWindow,
          lineDate: parseLineDate(first.text),
        });
        // Skip ahead past this cluster
        i = end;
      }
    }
  }

  const cleanResults = proximityResults.filter((r) => !isToolLine(r.text));
  const { freq: proxFreq, totalFiles: proxTotal } = computeCorpusFrequency();
  const proxIdf = buildIdfWeights(terms, proxFreq, proxTotal);
  const ranked = rankResults(cleanResults, { accessMap: getAccessMap(), idfWeights: proxIdf });
  recordAccess(ranked.map((r) => `${r.sourcePath}:${r.line}`));
  return track({
    results: ranked,
    layer: "proximity",
    totalMatches: cleanResults.length,
  });
}
