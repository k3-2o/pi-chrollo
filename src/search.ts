// Chrollo search — the flat pipeline. tokenize → rg → parse/filter → format.
// ripgrep does the heavy lifting (search + `--sort modified` recency in one
// call). We only: build patterns from the query terms, run rg, filter each
// matched line (drop toolResult / thinking / metadata), and emit markers.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { queryTerms } from "./tokenize.js";
import { parseLine, type MessageRecord } from "./normalize.js";
import { defaultRoot } from "./corpus.js";
import { formatSearchLine } from "./format.js";

const execFileAsync = promisify(execFile);

export const MAX_RESULTS = 15;
export const PER_FILE_CAP = 3;

// rg stdout can be large for a common term. Capped per file so one fat session
// can't flood us; a generous buffer so a legit big result set isn't truncated.
const RG_TIMEOUT_MS = 30000;
const RG_MAX_BUFFER = 100 * 1024 * 1024;
const RG_MAX_COUNT_PER_FILE = 5;

// Yield to the event loop every N parsed matches so the TUI render thread can
// paint between batches.
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
// `signal` is wired into execFile so Esc genuinely cancels the scan. A timeout
// throws (honest — never reported as "no memories"); rg exit code 1 (no match)
// or a real error returns [].
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
    "--sort",
    "modified",
    "-m",
    String(RG_MAX_COUNT_PER_FILE),
  ];
  for (const p of patterns) flags.push("-e", p);
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
      throw new Error("search timed out"); // not a miss — tell the user why
    }
    return []; // rg exit 1 (no match) or other error: empty, not interrupted
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

// Convert rg matches into formatted markers. Structural filter (drop non-message
// lines and tool outputs) happens here via parseLine. Matches are already
// recency-sorted by rg (`--sort modified`); we apply a per-file diversity cap
// and slice to MAX_RESULTS. Deterministic; yields to the event loop between
// chunks so a fat common-term search doesn't block the TUI.
export async function buildSearchResults(matches: RgMatch[]): Promise<string[]> {
  const perFile = new Map<string, number>();
  const out: MessageRecord[] = [];
  for (let i = 0; i < matches.length; i++) {
    if (i > 0 && i % PARSE_CHUNK === 0) await yieldToEventLoop();
    const m = matches[i];
    const rec = parseLine(m.path, m.line, m.text);
    if (rec === null || rec.kind !== "message") continue; // structural filter
    if (rec.text.length === 0) continue; // nothing to show

    // rg --sort modified already groups most-recent files first; spread per file.
    const file = m.path;
    const n = perFile.get(file) ?? 0;
    if (n >= PER_FILE_CAP) continue;
    perFile.set(file, n + 1);

    out.push(rec);
    if (out.length >= MAX_RESULTS) break;
  }
  return out.map((r) => formatSearchLine(r));
}

// Main search entry. Extract terms, run rg, build markers. No corpus stats, no
// typo fallback, no ranking — rg `-F` substring match + mtime sort covers it.
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
  return await buildSearchResults(matches);
}
