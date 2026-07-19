// --- Chrollo Search Layer ---

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMemoriesDir } from "./storage.js";
import { recordMetric } from "./metrics.js";

const execFileAsync = promisify(execFile);

export interface CompactResult {
  text: string;
  source: string;
  sourcePath: string; // --- full path for agent ---
  line: number;
  matchedTerms: string[];
  lineDate?: Date; // --- per-line timestamp ---
}

export interface SearchResponse {
  results: CompactResult[];
  layer: "and" | "proximity" | "trigram";
  totalMatches: number;
}

const MAX_RESULTS = 20;
const PER_FILE_CAP = 3; // --- diversity: max results from any one session file (AD-9) ---
const RECENCY_BOOST = 1.0;
const RECENCY_HALF_LIFE_DAYS = 30;
// --- lambda so that exp(-HALF_LIFE/lambda) = 0.5  ->  lambda = HALF_LIFE / ln(2) ---
const RECENCY_LAMBDA = RECENCY_HALF_LIFE_DAYS / Math.LN2;
const PROXIMITY_WINDOW = 20; // --- default lines for proximity search ---

// --- Stopwords (trimmed — no more "remember", "talked", "thing" etc) ---

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

// --- Helpers ---

// --- Tokenize: split code identifiers (camelCase / snake_case / kebab / acronyms),
//     lowercase, drop fragments length <= 2. Shared by corpus freq + term extraction.
//     Code identifiers are the most distinctive tokens in a memory tool for coding;
//     splitting them recovers recall (optimizeRerenders -> optimize + renders). ---
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

// --- Light stemming (AD-11): strip ONE common suffix from words longer than 4
//     chars, keeping the root if it's >= 3 chars. Because ripgrep -F matches
//     SUBSTRINGS, grepping the stem catches all inflections at once:
//     stem("deployment")="deploy" matches deploy/deploys/deploying/deployed/deployment.
//     This partially offsets the recall lost when the thesaurus was removed (AD-7).
//     Over-stem guard: skip if root would be < 3 chars ("using"->"us" is rejected).
//     Trade-off: "er" occasionally over-matches (docker->dock), mitigated by the
//     corpus-frequency rarity filter downstream.
const STEM_SUFFIXES = ["ment", "ion", "ing", "ed", "er", "es", "s"]; // longest first
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

// --- Expand a term into [term, stem] when stemming changes it. Each entry is a
//     grep pattern (OR within the group); the AND search requires every GROUP
//     to match, not every literal. ---
export function groupWithStem(term: string): string[] {
  const s = stem(term);
  return s !== term ? [term, s] : [term];
}

// --- Trigram typo fallback (AD-12): as a last resort, split a term into 3-char
//     trigrams and OR them as a regex. Catches typos (recieve<->receive share
//     'rec' and 'ive') and partial spellings without embeddings. Only fires on
//     AND-miss, only for terms length>=4. Returns null if the term is too short
//     to produce >=2 trigrams. ---
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

// --- Last-resort trigram OR search across all query terms. Loosens AND to OR
//     (any term's trigrams match). Results are flagged layer 'trigram'. ---
async function trigramFallback(terms: string[], signal?: AbortSignal): Promise<SearchResponse> {
  const dir = getMemoriesDir();
  if (!fs.existsSync(dir)) return { results: [], layer: "trigram", totalMatches: 0 };

  // Build one combined alternation from every term's trigrams (OR across all).
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
  return { results: rankResults(clean), layer: "trigram", totalMatches: clean.length };
}

// --- Parse a memory filename's date as LOCAL time.
//     storage.ts writes filenames via getMonth()/getDate() (local), so we must read
//     them as local -- not append "Z" (UTC), which skewed recency for users ahead
//     of UTC (today's memories parsed as "future" -> no boost). ---
export function parseFileDate(filename: string): Date | undefined {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})_\d{6}_[a-f0-9]+\.md$/);
  if (m === null) return undefined;
  const dt = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  return isNaN(dt.getTime()) ? undefined : dt;
}

// --- Parse a [YYYY-MM-DD HH:MM:SS] line timestamp as LOCAL time (same reason). ---
export function parseLineDate(line: string): Date | undefined {
  const m = line.match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/);
  if (m === null) return undefined;
  const dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(dt.getTime()) ? undefined : dt;
}

// --- Recency multiplier: 30-day half-life exponential decay.
//     today=2.0x, week~1.85x, month=1.5x, 3mo~1.13x, year~1.0x.
//     The old inverse curve (1/(d+1)) decayed too fast (~7-day half-life),
//     flattening after a week so "last month" signal was lost. ---
export function recencyMultiplier(lineDate: Date | undefined): number {
  if (lineDate === undefined) return 1.0;
  const now = Date.now();
  const daysSince = (now - lineDate.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < 0) return 1.0; // future-dated: no boost, no penalty
  return 1 + RECENCY_BOOST * Math.exp(-daysSince / RECENCY_LAMBDA);
}

// --- Corpus word frequency (for filtering common words) ---
// Persisted to .chrollo/freq.json (the parent of the memories dir, NOT inside
// memories/ — otherwise it'd be scanned as a memory file). Fingerprinted by
// (fileCount, totalBytes) so it's reused only when the corpus is unchanged;
// rebuilt lazily on first search after any change. Invalidated explicitly on
// session_start and after each agent_end append (see invalidateCorpusCache()).

let _corpusFreqCache: Map<string, number> | null = null;
let _corpusTotalFiles = 0;

// --- Invalidate the in-memory cache. Call at session_start and after each
//     successful append so the next search sees the new words (AD-2). ---
export function invalidateCorpusCache(): void {
  _corpusFreqCache = null;
  _corpusTotalFiles = 0;
}

function corpusCachePath(): string {
  // parent of the memories dir = the .chrollo/ (or global) root
  return path.join(path.dirname(getMemoriesDir()), "freq.json");
}

interface PersistedFreq {
  fileCount: number;
  totalBytes: number;
  freq: Array<[string, number]>;
}

// --- Compute (or reuse) the corpus frequency map. Async + persisted.
//     Reads files in parallel via fs/promises; falls back to empty if the
//     memories dir is absent. Public so index.ts can pre-warm at session_start. ---
export async function computeCorpusFrequency(): Promise<{
  freq: Map<string, number>;
  totalFiles: number;
}> {
  if (_corpusFreqCache !== null) {
    return { freq: _corpusFreqCache, totalFiles: _corpusTotalFiles };
  }

  const dir = getMemoriesDir();
  if (!fs.existsSync(dir)) {
    _corpusFreqCache = new Map();
    _corpusTotalFiles = 0;
    return { freq: _corpusFreqCache, totalFiles: 0 };
  }

  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".md"));

  // Fingerprint: count + total bytes. If the persisted cache matches, reuse it.
  let totalBytes = 0;
  const statTasks = files.map(async (f) => {
    const st = await fsp.stat(path.join(dir, f));
    totalBytes += st.size;
    return st.size;
  });
  await Promise.all(statTasks);

  const reused = tryLoadPersisted(corpusCachePath(), files.length, totalBytes);
  if (reused !== null) {
    _corpusFreqCache = reused.freq;
    _corpusTotalFiles = files.length;
    return { freq: reused.freq, totalFiles: files.length };
  }

  // Cold: read + tokenize all files in parallel, then aggregate.
  const freq = new Map<string, number>();
  const contents = await Promise.all(files.map((f) => fsp.readFile(path.join(dir, f), "utf-8")));
  for (const content of contents) {
    for (const word of new Set(tokenize(content))) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  _corpusFreqCache = freq;
  _corpusTotalFiles = files.length;
  trySavePersisted(corpusCachePath(), files.length, totalBytes, freq);
  return { freq, totalFiles: files.length };
}

// --- Persisted-cache helpers (best-effort; any failure just means a rebuild). ---

function tryLoadPersisted(
  cachePath: string,
  fileCount: number,
  totalBytes: number,
): { freq: Map<string, number> } | null {
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedFreq;
    if (
      parsed.fileCount === fileCount &&
      parsed.totalBytes === totalBytes &&
      Array.isArray(parsed.freq)
    ) {
      return { freq: new Map(parsed.freq) };
    }
  } catch {
    // missing or corrupt -> rebuild
  }
  return null;
}

function trySavePersisted(
  cachePath: string,
  fileCount: number,
  totalBytes: number,
  freq: Map<string, number>,
): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const payload: PersistedFreq = {
      fileCount,
      totalBytes,
      freq: [...freq.entries()],
    };
    fs.writeFileSync(cachePath, JSON.stringify(payload), "utf-8");
  } catch {
    // best-effort; ignore write failures
  }
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

// --- Rank results by term density + recency ---

export function rankResults(results: CompactResult[]): CompactResult[] {
  // Dedup by file:line
  const seen = new Set<string>();
  const unique: CompactResult[] = [];
  for (const r of results) {
    const key = `${r.sourcePath}:${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  // Sort: more DISTINCT matched terms first, then recency boost.
  // Dedup so a word appearing 3x on one line doesn't triple the score.
  unique.sort((a, b) => {
    const aScore = new Set(a.matchedTerms).size * recencyMultiplier(a.lineDate);
    const bScore = new Set(b.matchedTerms).size * recencyMultiplier(b.lineDate);
    return bScore - aScore;
  });

  // Diversity (AD-9): after sorting by score, allow at most PER_FILE_CAP
  // results from any single source file. Prevents one long session from
  // drowning out matches spread across others. The agent can still `read`
  // deeper into a capped file.
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

/**
 * AND search: all extracted terms must appear in the same file.
 * On AND-miss, falls back to a trigram typo search (AD-12); the thesaurus
 * was removed in AD-7 (WordNet polysemy made it net-negative).
 */
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

  const { freq, totalFiles } = await computeCorpusFrequency();
  const terms = extractDistinctiveTerms(query, freq, totalFiles);

  if (terms.length === 0) {
    return track({ results: [], layer: "and", totalMatches: 0 });
  }

  // Step 1: single-pass AND — one rg call, file-level AND in JS, lines for free
  const { files: andFiles, lines: andLines } = await singlePassAndSearch(terms, signal);
  if (signal?.aborted) throw new Error("read_memory: aborted");

  if (andFiles.length > 0) {
    const ranked = rankResults(andLines);
    return track({ results: ranked, layer: "and", totalMatches: andLines.length });
  }

  // AND-miss: last-resort trigram typo fallback (AD-12). Loosens to OR across
  // 3-char sub-patterns so typos / partial spellings still surface something.
  if (signal?.aborted) throw new Error("read_memory: aborted");
  return track(await trigramFallback(terms, signal));
}

/**
 * Proximity search: terms must appear within N lines of each other.
 * Used for auto-injection — finds conceptually dense passages.
 */
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
  const ranked = rankResults(cleanResults);
  return track({
    results: ranked,
    layer: "proximity",
    totalMatches: cleanResults.length,
  });
}
