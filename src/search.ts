// Chrollo search — the pipeline: tokenize → rg → parse/filter → rank → format.
// ripgrep finds + recency-orders matches (`--sortr modified`); we then re-rank by
// how many of the query's DISTINCT terms each message actually contains (a line
// holding k3s+ingress+timeout beats a recent line with just k3s), tie-breaking
// by rg's recency order. No corpus scan, no persistent stats.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { queryTerms } from "./tokenize.js";
import { parseLine, type MessageRecord } from "./normalize.js";
import { defaultRoot } from "./corpus.js";
import { formatSearchLine } from "./format.js";

const execFileAsync = promisify(execFile);

export const MAX_RESULTS = 15;
export const PER_FILE_CAP = 3;

// rg per-file match cap: must be large enough that a real answer buried
// mid-session is reachable for ranking (we trim after scoring, not before).
const RG_TIMEOUT_MS = 30000;
const RG_MAX_BUFFER = 100 * 1024 * 1024;
const RG_MAX_COUNT_PER_FILE = 200;

// Yield to the event loop every N parsed matches so the TUI can paint between
// batches on a common-term search.
const PARSE_CHUNK = 200;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// One rg match event, normalized.
export interface RgMatch {
  path: string;
  line: number; // 1-based
  text: string;
}

// Injectable ripgrep runner. The real one spawns rg; tests stub it.
export type RgRunner = (
  patterns: string[],
  root: string,
  signal?: AbortSignal,
) => Promise<RgMatch[]>;

// Run rg once with literal substring terms, per-file cap, recency (mtime) sort.
// `signal` is wired into execFile so Esc genuinely cancels. A timeout throws
// (honest — never a fake "no memories"); rg exit 1 (no match) or other errors
// return [].
export async function runRipgrep(
  patterns: string[],
  root: string,
  signal?: AbortSignal,
): Promise<RgMatch[]> {
  if (patterns.length === 0) return [];
  const flags = [
    "--json",
    "-n",
    "-F",
    "-i",
    "--sortr",
    "modified",
    "-m",
    String(RG_MAX_COUNT_PER_FILE),
  ];
  for (const term of patterns) flags.push("-e", term);
  flags.push("--", root);
  try {
    const res = await execFileAsync("rg", flags, {
      timeout: RG_TIMEOUT_MS,
      maxBuffer: RG_MAX_BUFFER,
      signal,
    });
    return parseRgJson(res.stdout);
  } catch (err) {
    if (signal?.aborted) return []; // real cancellation
    const e = err as { killed?: boolean; signal?: string };
    if (e?.killed || e?.signal === "SIGTERM") {
      throw new Error("search timed out");
    }
    return []; // no-match or non-interrupt error: empty
  }
}

// Parse rg --json stdout into RgMatch[]. Pure.
export function parseRgJson(stdout: string): RgMatch[] {
  const out: RgMatch[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type !== "match") continue;
    out.push({
      path: ev.data?.path?.text ?? "",
      line: ev.data?.line_number ?? 0,
      text: typeof ev.data?.lines?.text === "string" ? ev.data.lines.text.replace(/\n$/, "") : "",
    });
  }
  return out;
}

// Count how many DISTINCT query terms appear in a line (case-insensitive).
function overlapTerms(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const t of terms) if (lower.includes(t.toLowerCase())) n++;
  return n;
}

// Convert rg matches into formatted markers. Structural filter (tool outputs,
// thinking, metadata) via parseLine; then rank by distinct-query-term overlap
// (a line with MORE of your terms is more relevant regardless of file age),
// tie-broken by the order rg gave us (--sortr modified = most-recent-file
// first). Apply per-file diversity cap + slice to MAX_RESULTS after ranking.
export async function buildSearchResults(matches: RgMatch[], terms: string[]): Promise<string[]> {
  const cands: { rec: MessageRecord; overlap: number }[] = [];
  for (let i = 0; i < matches.length; i++) {
    if (i > 0 && i % PARSE_CHUNK === 0) await yieldToEventLoop();
    const m = matches[i];
    const rec = parseLine(m.path, m.line, m.text);
    if (rec === null || rec.kind !== "message") continue; // structural filter
    if (rec.text.length === 0) continue;
    cands.push({ rec, overlap: overlapTerms(rec.text, terms) });
  }

  // stable sort: overlap DESC; ties retain rg's recency order.
  cands.sort((a, b) => b.overlap - a.overlap);

  const perFile = new Map<string, number>();
  const out: MessageRecord[] = [];
  for (const c of cands) {
    const file = c.rec.lineKey.slice(0, c.rec.lineKey.lastIndexOf(":"));
    const n = perFile.get(file) ?? 0;
    if (n >= PER_FILE_CAP) continue;
    perFile.set(file, n + 1);
    out.push(c.rec);
    if (out.length >= MAX_RESULTS) break;
  }
  return out.map((r) => formatSearchLine(r));
}

// Main search entry. Extract distinctive terms, run rg, filter, rank, format.
export async function search(
  query: string,
  opts: {
    root?: string;
    excludePath?: string;
    runRg?: RgRunner; // injectable for tests
    signal?: AbortSignal; // tool-call cancellation, wired into execFile
  } = {},
): Promise<string[]> {
  const root = opts.root ?? defaultRoot();
  const runRg = opts.runRg ?? runRipgrep;

  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const matches = (await runRg(terms, root, opts.signal)).filter(
    (m) => m.path !== opts.excludePath,
  );
  return await buildSearchResults(matches, terms);
}
