/**
 * Chrollo Search Layer
 *
 * grep over raw session files. The simplest possible retrieval.
 * Returns matches with ±3 lines of surrounding context.
 *
 * This is the foundation — prove this works before adding anything else.
 * The agent is always in the loop, so exact match + context is enough for ~70% of cases.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { getMemoriesDir } from "./storage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  text: string;
  source: string;
  sourcePath: string; // full path for agent to read directly
  line: number;
  contextBefore: Array<{ text: string; lineNum: number }>;
  contextAfter: Array<{ text: string; lineNum: number }>;
  matchedTerms: string[];
  lineDate?: Date; // per-line timestamp from [YYYY-MM-DD HH:MM:SS]
}

export interface SearchResponse {
  results: SearchResult[];
  layer: "grep" | "grep+thesaurus";
  totalMatches: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTEXT_WINDOW = 3; // ±3 lines around each match
const MAX_RESULTS = 10;
const RECENCY_BOOST = 1.0; // multiplier for recent results
const RECENCY_HALF_DAYS = 30; // half-life in days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract content words from a query string.
 * Strips stop words and short tokens.
 */
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
    .replace(/[^\w\s]/g, " ") // strip punctuation
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

/**
 * Read a file and return its lines. Returns empty array on error.
 */
function readLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, "utf-8").split("\n");
  } catch {
    return [];
  }
}

/**
 * Extract the date from a Chrollo filename (YYYY-MM-DD_HHMMSS_prefix.md).
 * Returns null if the filename doesn't match the expected format.
 */
function parseFileDate(filename: string): Date | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_\d{6}_[a-f0-9]+\.md$/);
  if (match === null) return null;
  const d = new Date(match[1] + "T12:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parse the per-line timestamp from a conversation line.
 * New format: [YYYY-MM-DD HH:MM:SS] [User] text
 * Old format: [HH:MM:SS] [User] text
 * Returns null if no date found (old format — use filename date as fallback).
 */
function parseLineDate(line: string): Date | null {
  const match = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/);
  if (match === null) return null;
  const d = new Date(match[1] + "T" + match[2] + "Z");
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Compute the recency multiplier for a line date or file date.
 * Formula: 1 + RECENCY_BOOST / (days_since + 1)
 * Today's results get a 2× boost. 30-day-old get ~1.03×. A year old gets ~1.003×.
 * Recency is a nudge, never an override.
 */
function recencyMultiplier(fileDate: Date | null): number {
  if (fileDate === null) return 1.0;
  const now = Date.now();
  const daysSince = (now - fileDate.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < 0) return 1.0; // future dates = no boost
  return 1 + RECENCY_BOOST / (daysSince + 1);
}

// ---------------------------------------------------------------------------
// Thesaurus
// ---------------------------------------------------------------------------

let _thesaurusCache: Record<string, string[]> | null = null;

/**
 * Load the thesaurus JSON from disk. Cached after first load.
 * Returns empty object if file doesn't exist.
 */
function loadThesaurus(): Record<string, string[]> {
  if (_thesaurusCache !== null) return _thesaurusCache;

  const thesaurusPath = path.join(os.homedir(), ".chrollo", "thesaurus.json");
  try {
    const data = fs.readFileSync(thesaurusPath, "utf-8");
    _thesaurusCache = JSON.parse(data) as Record<string, string[]>;
  } catch {
    _thesaurusCache = {};
  }

  return _thesaurusCache;
}

/**
 * Expand a list of terms with their synonyms from the thesaurus.
 * Returns deduplicated list: original terms first, then synonyms.
 */
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search all session files for the given query using grep (exact substring match),
 * falling through to thesaurus-expanded search if nothing is found.
 *
 * Returns results with surrounding context, ranked by recency-weighted term density.
 */
export function grepSearch(query: string): SearchResponse {
  const terms = extractTerms(query);

  if (terms.length === 0) {
    return { results: [], layer: "grep", totalMatches: 0 };
  }

  // Step 1: try exact grep (handles ~70% of queries)
  const exactResult = runGrep(terms);
  if (exactResult.results.length > 0) {
    return { ...exactResult, layer: "grep" };
  }

  // Step 2: try thesaurus-expanded grep (handles ~+20%, cumulative ~90%)
  const expandedTerms = expandTerms(terms);

  // Skip if expansion didn't add anything
  if (expandedTerms.length <= terms.length) {
    return { results: [], layer: "grep+thesaurus", totalMatches: 0 };
  }

  const expandedResult = runGrep(expandedTerms);
  return { ...expandedResult, layer: "grep+thesaurus" };
}

/**
 * Core grep logic: use ripgrep to find matching files, then extract context.
 *
 * Why ripgrep instead of JS loop:
 *   - rg is written in Rust with SIMD — searches 100k files in milliseconds
 *   - JS would read every file and scan every line — slow at scale
 *   - rg -l (files-with-matches) gives us the needle, we extract context
 *   - Our context extraction code stays the same
 */
function runGrep(terms: string[]): SearchResponse {
  const memoriesDir = getMemoriesDir();

  if (!fs.existsSync(memoriesDir)) {
    return { results: [], layer: "grep", totalMatches: 0 };
  }

  // Use ripgrep to find which files contain any of the terms
  const termFlags: string[] = [];
  for (const term of terms) {
    termFlags.push("-e", term);
  }

  let rgStdout: string;
  try {
    rgStdout = execFileSync(
      "rg",
      [
        "-F", // fixed strings (not regex)
        "-i", // case-insensitive
        "-l", // files-with-matches only
        ...termFlags,
        memoriesDir,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
  } catch {
    // rg exits 1 (no matches) or 2 (error) — both mean no results
    return { results: [], layer: "grep", totalMatches: 0 };
  }

  const matchedFiles = rgStdout.trim().split("\n").filter(Boolean);
  if (matchedFiles.length === 0) {
    return { results: [], layer: "grep", totalMatches: 0 };
  }

  // Read matched files and extract matching lines with context
  const allResults: SearchResult[] = [];

  for (const filePath of matchedFiles) {
    const source = path.basename(filePath);
    const lines = readLines(filePath);
    if (lines.length === 0) continue;

    // Find lines matching any term
    const matchedIndices = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i]!.toLowerCase();
      for (const term of terms) {
        if (lower.includes(term)) {
          matchedIndices.add(i);
          break;
        }
      }
    }

    // For each matched line, build a result with context
    for (const idx of matchedIndices) {
      const matchedTermsForLine: string[] = [];
      const lower = lines[idx]!.toLowerCase();
      for (const term of terms) {
        if (lower.includes(term)) {
          matchedTermsForLine.push(term);
        }
      }

      const start = Math.max(0, idx - CONTEXT_WINDOW);
      const end = Math.min(lines.length - 1, idx + CONTEXT_WINDOW);

      const contextBefore: Array<{ text: string; lineNum: number }> = [];
      for (let i = start; i < idx; i++) {
        contextBefore.push({ text: lines[i]!, lineNum: i + 1 });
      }

      const contextAfter: Array<{ text: string; lineNum: number }> = [];
      for (let i = idx + 1; i <= end; i++) {
        contextAfter.push({ text: lines[i]!, lineNum: i + 1 });
      }

      allResults.push({
        text: lines[idx]!,
        source,
        sourcePath: filePath, // full path for agent to read directly
        line: idx + 1,
        contextBefore,
        contextAfter,
        matchedTerms: matchedTermsForLine,
        lineDate: parseLineDate(lines[idx]!),
      });
    }
  }

  // Rank by term count, deduplicate, apply recency
  allResults.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length);
  const deduped = deduplicateResults(allResults);
  deduped.sort((a, b) => {
    // Use per-line date if available, otherwise fall back to file date
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

/**
 * Remove overlapping results — if two matches are within CONTEXT_WINDOW lines
 * of each other in the same file, keep the one with more matched terms.
 */
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

/**
 * Format search results as a string for injection into the agent's context.
 */
export function formatResultsForContext(response: SearchResponse): string {
  if (response.results.length === 0) {
    return "";
  }

  const lines: string[] = [];

  for (const result of response.results) {
    lines.push(`--- ${result.sourcePath}:${result.line} ---`);

    for (const ctx of result.contextBefore) {
      lines.push(`  ${ctx.text} ...(line ${ctx.lineNum})`);
    }

    lines.push(`→ ${result.text} ...(line ${result.line})`);

    for (const ctx of result.contextAfter) {
      lines.push(`  ${ctx.text} ...(line ${ctx.lineNum})`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
