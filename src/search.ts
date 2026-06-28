// --- Chrollo Search Layer ---

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMemoriesDir } from "./storage.js";

const execFileAsync = promisify(execFile);

export interface SearchResult {
  text: string;
  source: string;
  sourcePath: string; // --- full path for agent ---
  line: number;
  contextBefore: Array<{ text: string; lineNum: number }>;
  contextAfter: Array<{ text: string; lineNum: number }>;
  matchedTerms: string[];
  lineDate?: Date; // --- per-line timestamp ---
}

export interface SearchResponse {
  results: SearchResult[];
  layer: "grep" | "grep+thesaurus";
  totalMatches: number;
}

const CONTEXT_WINDOW = 3; // --- lines around each match ---
const MAX_RESULTS = 10;
const RECENCY_BOOST = 1.0; // --- recency multiplier ---
const RECENCY_HALF_DAYS = 30; // --- recency half-life ---

// --- Helpers ---

function extractTerms(query: string): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "the",
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
    "thing",
    "things",
    "really",
    "something",
    "anything",
    "remember",
    "mentioned",
    "talked",
  ]);

  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ") // --- strip punctuation ---
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

function tryParseDate(dateStr: string): Date | undefined {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? undefined : d;
}

// --- Parse date from filename ---
function parseFileDate(filename: string): Date | undefined {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_\d{6}_[a-f0-9]+\.md$/);
  if (match === null) return undefined;
  return tryParseDate(match[1] + "T12:00:00Z") ?? undefined;
}

// --- Parse per-line timestamp ---
function parseLineDate(line: string): Date | undefined {
  const match = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/);
  if (match === null) return undefined;
  return tryParseDate(match[1] + "T" + match[2] + "Z") ?? undefined;
}

// --- 1 + boost/(days+1) recency. Nudge, not override ---
function recencyMultiplier(fileDate: Date | undefined): number {
  if (fileDate === undefined) return 1.0;
  const now = Date.now();
  const daysSince = (now - fileDate.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < 0) return 1.0; // --- future dates = no boost ---
  return 1 + RECENCY_BOOST / (daysSince + 1);
}

// --- Thesaurus ---

let _thesaurusCache: Record<string, string[]> | null = null;

function loadThesaurus(): Record<string, string[]> {
  if (_thesaurusCache !== null) return _thesaurusCache;

  // --- try user's custom thesaurus in ~/.chrollo/ first ---
  const userPath = path.join(os.homedir(), ".chrollo", "thesaurus.json");
  try {
    const data = fs.readFileSync(userPath, "utf-8");
    _thesaurusCache = JSON.parse(data) as Record<string, string[]>;
    return _thesaurusCache;
  } catch {
    // --- fall through to bundled thesaurus ---
  }

  // --- fall back to thesaurus.json shipped alongside the extension ---
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

function expandTerms(terms: string[]): string[] {
  const thesaurus = loadThesaurus();
  const expanded = new Set(terms);

  for (const term of terms) {
    const synonyms = thesaurus[term];
    if (synonyms !== undefined) {
      for (const syn of synonyms) {
        expanded.add(syn);
      }
    }
  }

  return [...expanded];
}

// --- Public API ---

export async function grepSearch(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  const terms = extractTerms(query);

  if (signal?.aborted) {
    throw new Error("read_memory: aborted");
  }

  if (terms.length === 0) {
    return { results: [], layer: "grep", totalMatches: 0 };
  }

  // --- Step 1: try exact grep ---
  const exactResult = await runGrep(terms, signal);
  if (signal?.aborted) {
    throw new Error("read_memory: aborted");
  }
  if (exactResult.results.length > 0) {
    return { ...exactResult, layer: "grep" };
  }

  // --- Step 2: thesaurus-expanded fallback ---
  const expandedTerms = expandTerms(terms);

  // --- skip if expansion didn't add anything ---
  if (expandedTerms.length <= terms.length) {
    return { results: [], layer: "grep+thesaurus", totalMatches: 0 };
  }

  const expandedResult = await runGrep(expandedTerms, signal);
  return { ...expandedResult, layer: "grep+thesaurus" };
}

// --- Core grep logic: ripgrep JSON output + lightweight JS parsing ---
async function runGrep(terms: string[], signal?: AbortSignal): Promise<SearchResponse> {
  const memoriesDir = getMemoriesDir();

  if (signal?.aborted) {
    throw new Error("read_memory: aborted");
  }

  if (!fs.existsSync(memoriesDir)) {
    return { results: [], layer: "grep", totalMatches: 0 };
  }

  // --- use ripgrep --json to get matches with context in one pass ---
  // This avoids: fs.readFileSync per file + JS line iteration + term re-checking.
  // rg does all the heavy lifting in Rust — matching, context extraction, line numbering.
  // -m 5 caps output at ~5 matches per file, keeping JSON output <1MB even for broad queries.
  const termFlags: string[] = [];
  for (const term of terms) {
    termFlags.push("-e", term);
  }

  let rgStdout: string;
  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--json",
        "-C", String(CONTEXT_WINDOW),
        "-n",
        "-F", // --- fixed strings ---
        "-i", // --- case-insensitive ---
        "-m", "5", // --- max 5 matches per file (bounds output, still plenty for ranking) ---
        ...termFlags,
        memoriesDir,
      ],
      { signal, timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
    );
    rgStdout = stdout;
  } catch (err: unknown) {
    // --- rg exits 1 (no matches) or 2 (error). AbortError is re-thrown. ---
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("read_memory: aborted");
    }
    return { results: [], layer: "grep", totalMatches: 0 };
  }

  if (signal?.aborted) {
    throw new Error("read_memory: aborted");
  }

  // --- convert trailing-newline convenience: rg --json appends \n to lines.text ---
  const stripNewline = (s: string): string =>
    s.endsWith("\n") ? s.slice(0, -1) : s;

  // --- parse NDJSON lines into a flat event stream ---
  const events: Array<{ type: string; data: any }> = [];
  for (const raw of rgStdout.trim().split("\n")) {
    try {
      events.push(JSON.parse(raw));
    } catch {
      // skip malformed lines (shouldn't happen with rg)
    }
  }

  if (events.length === 0) {
    return { results: [], layer: "grep", totalMatches: 0 };
  }

  // --- group events by file (between begin / end markers) ---
  const allResults: SearchResult[] = [];
  let fileIdx = 0;

  while (fileIdx < events.length) {
    // skip to next "begin"
    while (fileIdx < events.length && events[fileIdx]!.type !== "begin") {
      fileIdx++;
    }
    if (fileIdx >= events.length) break;

    const sourcePath = events[fileIdx]!.data.path.text as string;
    const source = path.basename(sourcePath);
    fileIdx++; // move past "begin"

    // collect events until "end"
    const fileEvents: Array<{ type: string; data: any }> = [];
    while (fileIdx < events.length && events[fileIdx]!.type !== "end") {
      fileEvents.push(events[fileIdx]!);
      fileIdx++;
    }
    fileIdx++; // move past "end"

    // extract match events with surrounding context
    for (let i = 0; i < fileEvents.length; i++) {
      if (fileEvents[i]!.type !== "match") continue;

      const match = fileEvents[i]!;

      // context before: scan backward from i-1 up to CONTEXT_WINDOW
      const contextBefore: Array<{ text: string; lineNum: number }> = [];
      for (let j = i - 1; j >= 0 && fileEvents[j]!.type === "context" && contextBefore.length < CONTEXT_WINDOW; j--) {
        contextBefore.unshift({
          text: stripNewline(fileEvents[j]!.data.lines.text),
          lineNum: fileEvents[j]!.data.line_number as number,
        });
      }

      // context after: scan forward from i+1 up to CONTEXT_WINDOW
      const contextAfter: Array<{ text: string; lineNum: number }> = [];
      for (let j = i + 1; j < fileEvents.length && fileEvents[j]!.type === "context" && contextAfter.length < CONTEXT_WINDOW; j++) {
        contextAfter.push({
          text: stripNewline(fileEvents[j]!.data.lines.text),
          lineNum: fileEvents[j]!.data.line_number as number,
        });
      }

      allResults.push({
        text: stripNewline(match.data.lines.text),
        source,
        sourcePath,
        line: match.data.line_number as number,
        contextBefore,
        contextAfter,
        matchedTerms: (match.data.submatches as Array<{ match: { text: string } }>).map(
          (s) => s.match.text.toLowerCase(),
        ),
        lineDate: parseLineDate(match.data.lines.text),
      });
    }
  }

  if (signal?.aborted) {
    throw new Error("read_memory: aborted");
  }

  // --- rank + dedup + recency (unchanged logic) ---
  allResults.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length);
  const deduped = deduplicateResults(allResults);
  deduped.sort((a, b) => {
    const dateA = a.lineDate ?? parseFileDate(a.source);
    const dateB = b.lineDate ?? parseFileDate(b.source);
    const scoreA = a.matchedTerms.length * recencyMultiplier(dateA);
    const scoreB = b.matchedTerms.length * recencyMultiplier(dateB);
    return scoreB - scoreA;
  });

  return {
    results: deduped.slice(0, MAX_RESULTS),
    layer: "grep",
    totalMatches: allResults.length,
  };
}

function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const kept: SearchResult[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const key = `${result.source}:${Math.floor(result.line / (CONTEXT_WINDOW * 2))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(result);
  }

  return kept;
}
