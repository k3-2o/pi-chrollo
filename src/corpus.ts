// Chrollo corpus — discovers Pi's session files and computes the corpus stats
// BM25 needs. Pure-ish: synchronous I/O (matches the 0.2.0 atomicity lesson —
// no mid-handler yields), but lazy (only on first search) and cached.
//
// The "document" unit for BM25 is the MESSAGE LINE (consistent with rg's
// line-level matching): docFreq(t) = # message lines containing t, avgLen =
// average message-line token length, totalDocs = # message lines. Computing
// this requires parsing every line of every session — ~tens of ms over the
// current ~260-file corpus — so it is cached and invalidated by an
// mtime+size signature (the honest invalidation signal; no persisted cache).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseLine, extractSessionCwd } from "./normalize.js";
import { tokenize } from "./tokenize.js";

export interface CorpusStats {
  docFreq: Map<string, number>; // term → number of message lines containing it
  avgLen: number; // average message-line token length
  totalDocs: number; // total message lines
  fileCwd: Map<string, string>; // session file path → cwd (from session header)
}

const DEFAULT_ROOT_SEGMENTS = [".pi", "agent", "sessions"];

export function defaultRoot(): string {
  return path.join(os.homedir(), ...DEFAULT_ROOT_SEGMENTS);
}

function resolveRoot(root?: string): string {
  return root ?? defaultRoot();
}

// Recursively discover all *.jsonl files under root. No glob dependency — a
// manual walk keeps the runtime dep list at just ripgrep. Returns sorted paths.
export function discoverSessions(root?: string): string[] {
  const r = resolveRoot(root);
  const out: string[] = [];
  const stack: string[] = [];
  if (fs.existsSync(r)) stack.push(r);
  while (stack.length > 0) {
    const d = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue; // vanished or unreadable — skip
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    }
  }
  return out.sort();
}

// Deterministic signature of the file set + their mtimes/sizes. A change in
// any file's mtime or size (Pi appending a turn, rewriting on compaction, or a
// file being added/removed) produces a new signature → recompute.
function mtimeSignature(paths: string[]): string {
  const parts: string[] = [];
  for (const p of paths) {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue; // vanished between discover + signature — skip
    }
    parts.push(`${p}|${st.mtimeMs}|${st.size}`);
  }
  parts.sort();
  return parts.join("\n");
}

// Compute corpus stats by parsing every line of every file. Pure given paths —
// no caching, no side effects. Tests call this directly on fixture dirs.
export function computeStats(paths: string[]): CorpusStats {
  const docFreq = new Map<string, number>();
  const fileCwd = new Map<string, string>();
  let totalLen = 0;
  let totalDocs = 0;

  paths.forEach((p, _idx) => {
    let content: string;
    try {
      content = fs.readFileSync(p, "utf-8");
    } catch {
      return;
    }
    const lines = content.split("\n");
    let cwd: string | undefined;
    // Line numbers are irrelevant for stats; parseLine needs one, so pass 1-based.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      // Harvest cwd from the first session header we encounter.
      if (cwd === undefined) {
        const c = extractSessionCwd(line);
        if (c !== undefined) cwd = c;
      }
      const r = parseLine(p, i + 1, line);
      if (r === null || r.kind !== "message") continue;
      // docFreq counts documents (lines) containing t — use a per-line term set
      // so a term repeated within one line counts once for n(t). Line length
      // for BM25's |d| uses the full token count (with duplicates).
      const tokens = tokenize(r.text);
      for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      totalLen += tokens.length;
      totalDocs++;
    }
    if (cwd !== undefined) fileCwd.set(p, cwd);
  });

  return {
    docFreq,
    avgLen: totalDocs > 0 ? totalLen / totalDocs : 0,
    totalDocs,
    fileCwd,
  };
}

// Module-level cache. Lazily computed on first getCorpusStats call; invalidated
// when the file-set signature changes or invalidateCorpusCache() is called.
interface CacheEntry {
  root: string;
  signature: string;
  stats: CorpusStats;
}

let _cache: CacheEntry | null = null;

// Get corpus stats, computing (or recomputing) only when the file set or any
// file's mtime/size has changed since last call. Same-reference on cache hit.
export function getCorpusStats(root?: string): CorpusStats {
  const r = resolveRoot(root);
  const paths = discoverSessions(r);
  const signature = mtimeSignature(paths);

  if (_cache !== null && _cache.root === r && _cache.signature === signature) {
    return _cache.stats;
  }

  const stats = computeStats(paths);
  _cache = { root: r, signature, stats };
  return stats;
}

// Drop the in-memory cache. Call at session_shutdown (or between tests).
export function invalidateCorpusCache(): void {
  _cache = null;
}
