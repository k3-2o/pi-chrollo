// Chrollo search — the search pipeline. tokenize → rg → parse → structural
// filter → rank → diversity → format. Trigram typo fallback when rg returns
// zero. Returns one-line `path:line | preview` markers the agent feeds back
// into read.
//
// The ripgrep executor is injectable so tests don't depend on rg being
// installed — they pass a stub that returns canned match events.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { groupWithStem, trigramRegex, queryTerms } from "./tokenize.js";
import { parseLine } from "./normalize.js";
import { defaultRoot, readSessionCwd } from "./corpus.js";
import { rankCandidates, diversityCap } from "./rank.js";
import { formatSearchLine } from "./format.js";
import type { MessageRecord } from "./normalize.js";

const execFileAsync = promisify(execFile);

export const MAX_RESULTS = 15;
export const PER_FILE_CAP = 3;
const RG_TIMEOUT_MS = 5000;
// rg stdout can be large (a common term like 'chrollo' yields ~29MB / 6k matches).
// Two defenses: a generous buffer, and --max-count per file so one fat session
// cant flood us. We only ever rank the top MAX_RESULTS anyway.
const RG_MAX_BUFFER = 100 * 1024 * 1024;
const RG_MAX_COUNT_PER_FILE = 20;

// One rg match event, normalized. search() converts these into candidates.
export interface RgMatch {
  path: string;
  line: number; // 1-based
  text: string;
}

// Injectable ripgrep runner. The real one spawns rg; tests stub it. Returns
// the parsed match events (begin/end/summary discarded).
export type RgRunner = (patterns: string[], root: string) => Promise<RgMatch[]>;

// Default rg runner: one `rg --json` call with -e per pattern (substring match
// via -F for terms, regex for trigram fallback). Mirrors the 0.2.0 invocation
// that already proved sub-ms over the corpus.
export async function runRipgrep(patterns: string[], root: string): Promise<RgMatch[]> {
  if (patterns.length === 0) return [];
  const flags: string[] = ["--json", "-n", "-F", "-i", "-m", String(RG_MAX_COUNT_PER_FILE)];
  for (const p of patterns) flags.push("-e", p);
  flags.push("--", root);
  let stdout: string;
  try {
    const res = await execFileAsync("rg", flags, {
      timeout: RG_TIMEOUT_MS,
      maxBuffer: RG_MAX_BUFFER,
    });
    stdout = res.stdout;
  } catch {
    return []; // rg exits 1 on no-match, or errored — either way, no matches
  }
  return parseRgJson(stdout);
}

// Parse rg --json stdout into RgMatch[]. Pure — exported for testing.
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

// Convert rg matches into ranked, formatted search results. Pure given
// sessionCwd + the matches. The structural filter (drop non-message lines and
// tool outputs) happens here via parseLine. cwds are read lazily, one per
// unique matched file (cheap, never blocks on a corpus scan).
export function buildSearchResults(
  matches: RgMatch[],
  terms: string[],
  sessionCwd?: string,
  opts: { maxResults?: number; perFileCap?: number } = {},
): string[] {
  const cwdCache = new Map<string, string | undefined>();
  const candidates: { record: MessageRecord; lineCwd?: string }[] = [];
  for (const m of matches) {
    const rec = parseLine(m.path, m.line, m.text);
    if (rec === null || rec.kind !== "message") continue; // structural filter
    if (rec.text.length === 0) continue; // nothing to show
    if (!cwdCache.has(m.path)) cwdCache.set(m.path, readSessionCwd(m.path));
    candidates.push({ record: rec, lineCwd: cwdCache.get(m.path) });
  }

  const ranked = rankCandidates(candidates, terms, sessionCwd);
  const capped = diversityCap(ranked, opts.perFileCap ?? PER_FILE_CAP).slice(
    0,
    opts.maxResults ?? MAX_RESULTS,
  );
  return capped.map((r) => formatSearchLine(r.record));
}

// Main search entry. Extracts distinctive terms, runs rg, builds ranked
// results. On zero matches, retries once with a trigram typo fallback.
export async function search(
  query: string,
  opts: {
    root?: string;
    sessionCwd?: string;
    runRg?: RgRunner; // injectable for tests
  } = {},
): Promise<string[]> {
  const root = opts.root ?? defaultRoot();
  const runRg = opts.runRg ?? runRipgrep;

  // Content words only (stopwords dropped). No corpus dictionary — the rarity
  // filter that needed one was the 13s-freeze bug (SPEC §3.3), permanently gone.
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  // Expand each term into [term, stem] and flatten — rg ORs them, then a line
  // only scores if it actually contains the term or its stem (scoreLine).
  const patterns = terms.flatMap(groupWithStem);
  const matches = await runRg(patterns, root);

  let results = buildSearchResults(matches, terms, opts.sessionCwd);
  if (results.length > 0) return results;

  // Zero results — trigram typo fallback (one retry, OR of all trigram regexes).
  const trigramPatterns = terms.map(trigramRegex).filter((p): p is string => p !== null);
  if (trigramPatterns.length === 0) return [];
  // Trigram fallback uses regex, not -F. Inject a regex-aware runner if needed;
  // the default runRipgrep uses -F which would mis-interpret regex chars, so
  // for the fallback we call rg directly with regex mode.
  const fallbackMatches = await runRgRegex(trigramPatterns, root, opts.runRg ?? null);
  return buildSearchResults(fallbackMatches, terms, opts.sessionCwd);
}

// Trigram fallback needs regex matching (-F off). If the caller injected a
// custom runner, assume it handles regex; otherwise spawn rg without -F.
async function runRgRegex(
  patterns: string[],
  root: string,
  customRunner: RgRunner | null,
): Promise<RgMatch[]> {
  if (customRunner !== null) return customRunner(patterns, root);
  if (patterns.length === 0) return [];
  const flags: string[] = ["--json", "-n", "-i", "-m", String(RG_MAX_COUNT_PER_FILE)]; // NOTE: no -F
  for (const p of patterns) flags.push("-e", p);
  flags.push("--", root);
  try {
    const res = await execFileAsync("rg", flags, {
      timeout: RG_TIMEOUT_MS,
      maxBuffer: RG_MAX_BUFFER,
    });
    return parseRgJson(res.stdout);
  } catch {
    return [];
  }
}
