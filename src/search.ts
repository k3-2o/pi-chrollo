// --- Chrollo Search Layer ---

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMemoriesDir } from "./storage.js";

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
  layer: "and" | "and+thesaurus" | "proximity" | "fuzzy";
  totalMatches: number;
}

const MAX_RESULTS = 20;
const RECENCY_BOOST = 1.0;
const PROXIMITY_WINDOW = 20; // --- default lines for proximity search ---

// --- Stopwords (trimmed — no more "remember", "talked", "thing" etc) ---

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "about", "up", "down",
  "what", "which", "who", "whom", "this", "that", "these", "those",
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself", "she", "her", "hers", "herself",
  "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
  "also", "get", "got", "like", "know", "think", "want", "look",
  "use", "find", "give", "tell", "say", "said", "take", "come",
  "make", "go", "see",
]);

// --- Helpers ---

function tryParseDate(dateStr: string): Date | undefined {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseFileDate(filename: string): Date | undefined {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_\d{6}_[a-f0-9]+\.md$/);
  if (match === null) return undefined;
  return tryParseDate(match[1] + "T12:00:00Z") ?? undefined;
}

function parseLineDate(line: string): Date | undefined {
  const match = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/);
  if (match === null) return undefined;
  return tryParseDate(match[1] + "T" + match[2] + "Z") ?? undefined;
}

function recencyMultiplier(lineDate: Date | undefined): number {
  if (lineDate === undefined) return 1.0;
  const now = Date.now();
  const daysSince = (now - lineDate.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < 0) return 1.0;
  return 1 + RECENCY_BOOST / (daysSince + 1);
}

// --- Thesaurus (lazy-loaded, never used in auto-injection) ---

let _thesaurusCache: Record<string, string[]> | null = null;

function loadThesaurus(): Record<string, string[]> {
  if (_thesaurusCache !== null) return _thesaurusCache;

  const userPath = path.join(os.homedir(), ".chrollo", "thesaurus.json");
  try {
    const data = fs.readFileSync(userPath, "utf-8");
    _thesaurusCache = JSON.parse(data) as Record<string, string[]>;
    return _thesaurusCache;
  } catch {
    // fall through
  }

  try {
    const extensionDir = path.dirname(fileURLToPath(import.meta.url));
    const bundledPath = path.join(extensionDir, "..", "thesaurus.json");
    const data = fs.readFileSync(bundledPath, "utf-8");
    _thesaurusCache = JSON.parse(data) as Record<string, string[]>;
  } catch {
    _thesaurusCache = {};
  }

  return _thesaurusCache;
}

// --- Corpus word frequency (for filtering common words) ---

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
    const words = new Set(
      content
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  _corpusFreqCache = freq;
  _corpusTotalFiles = files.length;
  return { freq, totalFiles: files.length };
}

// --- Smart term extraction: 5 max, filtered by corpus frequency ---

export function extractDistinctiveTerms(
  query: string,
  corpusFreq: Map<string, number>,
  totalFiles: number,
): string[] {
  const raw = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

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

// --- AND search: all terms must appear in the same file ---

async function andSearch(
  terms: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const dir = getMemoriesDir();
  if (!fs.existsSync(dir)) return [];

  const fileSets: Set<string>[] = [];

  for (const term of terms) {
    try {
      const { stdout } = await execFileAsync(
        "rg",
        ["-l", "-i", "-F", "-e", term, dir],
        { signal, timeout: 3000, maxBuffer: 1024 * 1024 },
      );
      fileSets.push(new Set(stdout.trim().split("\n").filter((l) => l.length > 0)));
    } catch {
      // rg exits 1 when no match — that means AND fails
      return [];
    }
  }

  // Intersect all file sets
  if (fileSets.length === 0) return [];
  let result = fileSets[0];
  for (let i = 1; i < fileSets.length; i++) {
    result = new Set([...result].filter((x) => fileSets[i].has(x)));
    if (result.size === 0) return [];
  }

  return [...result];
}

/**
 * Grouped AND search: AND between groups, OR within each group.
 * First group is expanded with synonyms (OR). Remaining groups are individual terms (AND).
 */
async function groupedAndSearch(
  topGroup: string[],
  remainingTerms: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const dir = getMemoriesDir();
  if (!fs.existsSync(dir)) return [];

  // Get file set for the top group (OR: any term in the group)
  const topFlags: string[] = [];
  for (const t of topGroup) topFlags.push("-e", t);

  let topFiles: Set<string>;
  try {
    const { stdout } = await execFileAsync(
      "rg", ["-l", "-i", "-F", ...topFlags, dir],
      { signal, timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    topFiles = new Set(stdout.trim().split("\n").filter((l) => l.length > 0));
  } catch {
    return [];
  }

  if (topFiles.size === 0) return [];

  // AND with each remaining term
  let result = topFiles;
  for (const term of remainingTerms) {
    try {
      const { stdout } = await execFileAsync(
        "rg", ["-l", "-i", "-F", "-e", term, dir],
        { signal, timeout: 3000, maxBuffer: 1024 * 1024 },
      );
      const termFiles = new Set(stdout.trim().split("\n").filter((l) => l.length > 0));
      result = new Set([...result].filter((x) => termFiles.has(x)));
      if (result.size === 0) return [];
    } catch {
      return [];
    }
  }

  return [...result];
}

// --- Get raw matching lines from specific files ---

async function getMatchingLines(
  terms: string[],
  files: string[],
  signal?: AbortSignal,
): Promise<CompactResult[]> {
  if (files.length === 0) return [];

  const termFlags: string[] = [];
  for (const term of terms) {
    termFlags.push("-e", term);
  }

  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--json",
        "-n",
        "-F",
        "-i",
        ...termFlags,
        "--", // --- end of flags, positional files follow ---
        ...files,
      ],
      { signal, timeout: 3000, maxBuffer: 5 * 1024 * 1024 },
    );

    const results: CompactResult[] = [];
    for (const raw of stdout.trim().split("\n")) {
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
        line: ev.data.line_number,
        matchedTerms: (ev.data.submatches as Array<{ match: { text: string } }>).map(
          (s) => s.match.text.toLowerCase(),
        ),
        lineDate: parseLineDate(text),
      });
    }

    return results.filter((r) => !isToolLine(r.text));
  } catch {
    return [];
  }
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
    /^>\s+\$\s/.test(text) ||                            // > $ command
    /^>\s+read_memory\s/.test(text) ||                    // > read_memory query
    /^>\s+grep\s/.test(text) ||                           // > grep
    /^>\s+ls\s/.test(text) ||                             // > ls
    /^>\s+(read|edit|write|find)\s+(\/|\.\/|~\/|\w+\/)/.test(text) || // with path
    /^>\s+read\s+\w+\.\w+/.test(text) ||                // read filename.ext
    /^>\s+(edit|write)\s+\w+\.\w+/.test(text) ||        // edit/write filename.ext
    /^>\s+[a-z][a-zA-Z0-9_]*_\w+\s/.test(text)          // underscore tool names (composio_*)
  );
}

// --- Rank results by term density + recency ---

function rankResults(results: CompactResult[]): CompactResult[] {
  // Dedup by file:line
  const seen = new Set<string>();
  const unique: CompactResult[] = [];
  for (const r of results) {
    const key = `${r.sourcePath}:${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  // Sort: more matched terms first, then recency boost
  unique.sort((a, b) => {
    const aScore = a.matchedTerms.length * recencyMultiplier(a.lineDate);
    const bScore = b.matchedTerms.length * recencyMultiplier(b.lineDate);
    return bScore - aScore;
  });

  return unique.slice(0, MAX_RESULTS);
}

// --- Public API ---

/**
 * AND search: all extracted terms must appear in the same file.
 * Falls back to thesaurus expansion on the single most distinctive term
 * if AND returns nothing.
 */
export async function grepSearch(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  if (signal?.aborted) throw new Error("read_memory: aborted");

  const { freq, totalFiles } = computeCorpusFrequency();
  const terms = extractDistinctiveTerms(query, freq, totalFiles);

  if (terms.length === 0) {
    return { results: [], layer: "and", totalMatches: 0 };
  }

  // Step 1: AND search — all terms must appear in same file
  const andFiles = await andSearch(terms, signal);
  if (signal?.aborted) throw new Error("read_memory: aborted");

  if (andFiles.length > 0) {
    const lines = await getMatchingLines(terms, andFiles, signal);
    const ranked = rankResults(lines);
    return { results: ranked, layer: "and", totalMatches: lines.length };
  }

  // Step 2: Thesaurus fallback — expand most distinctive term, AND with remaining
  const topTerm = terms[0];
  const thesaurus = loadThesaurus();
  const synonyms = thesaurus[topTerm];
  if (synonyms === undefined || synonyms.length === 0) {
    return { results: [], layer: "and+thesaurus", totalMatches: 0 };
  }

  // Grouped AND: (topTerm OR syn1 OR syn2) AND remainingTerms
  const topGroup = [topTerm, ...synonyms];
  const remaining = terms.slice(1);
  const groupedFiles = await groupedAndSearch(topGroup, remaining, signal);
  if (signal?.aborted) throw new Error("read_memory: aborted");

  if (groupedFiles.length === 0) {
    return { results: [], layer: "and+thesaurus", totalMatches: 0 };
  }

  const lines = await getMatchingLines(terms, groupedFiles, signal);
  const ranked = rankResults(lines);
  return { results: ranked, layer: "and+thesaurus", totalMatches: lines.length };
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
  const dir = getMemoriesDir();
  if (!fs.existsSync(dir) || terms.length < 2) {
    return { results: [], layer: "proximity", totalMatches: 0 };
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
      [
        "--json",
        "-n",
        "-F",
        "-i",
        "-C", String(ctxLines),
        ...termFlags,
        dir,
      ],
      { signal, timeout: 3000, maxBuffer: 5 * 1024 * 1024 },
    );
    rgStdout = stdout;
  } catch {
    return { results: [], layer: "proximity", totalMatches: 0 };
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
  return {
    results: ranked,
    layer: "proximity",
    totalMatches: cleanResults.length,
  };
}

/**
 * Explicit fuzzy search: OR mode + full thesaurus expansion.
 * Not used in auto-injection. Agent calls this when grepSearch fails.
 */
export async function fuzzySearch(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  if (signal?.aborted) throw new Error("read_memory: aborted");

  const { freq, totalFiles } = computeCorpusFrequency();
  const terms = extractDistinctiveTerms(query, freq, totalFiles);

  if (terms.length === 0) {
    return { results: [], layer: "fuzzy", totalMatches: 0 };
  }

  // Expand ALL terms with thesaurus
  const thesaurus = loadThesaurus();
  const expanded = new Set(terms);
  for (const term of terms) {
    const syns = thesaurus[term];
    if (syns !== undefined) {
      for (const s of syns) expanded.add(s);
    }
  }

  // OR search: any term matches (original rg behavior)
  const expandedTerms = [...expanded];
  const termFlags: string[] = [];
  for (const t of expandedTerms) termFlags.push("-e", t);

  const dir = getMemoriesDir();
  if (!fs.existsSync(dir)) {
    return { results: [], layer: "fuzzy", totalMatches: 0 };
  }

  let rgStdout: string;
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--json", "-n", "-F", "-i", ...termFlags, dir],
      { signal, timeout: 3000, maxBuffer: 5 * 1024 * 1024 },
    );
    rgStdout = stdout;
  } catch {
    return { results: [], layer: "fuzzy", totalMatches: 0 };
  }

  const results: CompactResult[] = [];
  for (const raw of rgStdout.trim().split("\n")) {
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
      line: ev.data.line_number,
      matchedTerms: (ev.data.submatches as Array<{ match: { text: string } }>).map(
        (s) => s.match.text.toLowerCase(),
      ),
      lineDate: parseLineDate(text),
    });
  }

  const cleanResults = results.filter((r) => !isToolLine(r.text));
  const ranked = rankResults(cleanResults);
  return { results: ranked, layer: "fuzzy", totalMatches: cleanResults.length };
}
