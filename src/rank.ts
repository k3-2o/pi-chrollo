// Chrollo rank — scoring orchestration. Combines term relevance (TF-saturation
// with length normalization), recency (freshness), and a same-project cwd
// boost.
//
// NO global corpus stats — the IDF/rare-term component was the 13s-freeze bug
// (SPEC §3.3) and is permanently dropped. avgLen is computed locally from the
// candidate set, not scanned from disk.

import type { MessageRecord } from "./normalize.js";
import { tokenize, groupWithStem } from "./tokenize.js";
import { tfSaturation } from "./score.js";

const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_BOOST = 1.0; // multiplier range [1.0, 1.0 + RECENCY_BOOST]
const RECENCY_LAMBDA = RECENCY_HALF_LIFE_DAYS / Math.LN2; // so exp(-t/lambda)=0.5 at half-life
const CWD_BOOST = 1.2; // mild same-project boost

// 30-day half-life exponential decay. today ≈ 2.0, week ≈ 1.85, 3mo ≈ 1.13,
// year ≈ 1.0. Unknown (0) or future timestamps are neutral (1.0).
export function recencyMultiplier(
  timestamp: number,
  halfLifeDays = RECENCY_HALF_LIFE_DAYS,
): number {
  if (!timestamp) return 1.0;
  const now = Date.now();
  const daysSince = (now - timestamp) / (1000 * 60 * 60 * 24);
  if (daysSince < 0) return 1.0; // future-dated: neutral, no penalty
  const lambda = halfLifeDays / Math.LN2;
  return 1 + RECENCY_BOOST * Math.exp(-daysSince / lambda);
}

// Mild boost when the line's session cwd matches the current session cwd.
export function cwdBoost(lineCwd?: string, sessionCwd?: string): number {
  if (!lineCwd || !sessionCwd) return 1.0;
  return lineCwd === sessionCwd ? CWD_BOOST : 1.0;
}

// TF-saturation sum across query terms present in the line, × recency × cwd
// boost. Stem-aware: a query term and its light stem are counted as the same
// term so that a line surfaced via a stemmed rg match still scores correctly
// (query "deployment" matches a line containing "deploy").
export function scoreLine(
  record: MessageRecord,
  queryTerms: string[],
  avgLen: number,
  lineCwd?: string,
  sessionCwd?: string,
): number {
  const tokens = tokenize(record.text);
  const lineLen = tokens.length;
  const tokenCount = new Map<string, number>();
  for (const t of tokens) tokenCount.set(t, (tokenCount.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of queryTerms) {
    const group = groupWithStem(term);
    let tf = 0;
    for (const form of group) tf += tokenCount.get(form) ?? 0;
    if (tf === 0) continue; // term (nor its stem) in this line — contributes 0
    score += tfSaturation(tf, lineLen, avgLen);
  }

  return score * recencyMultiplier(record.timestamp) * cwdBoost(lineCwd, sessionCwd);
}

export interface RankedResult {
  record: MessageRecord;
  lineCwd?: string;
  score: number;
}

// Score, dedup by lineKey (defensive against rg returning a line twice), and
// sort by score descending. Pure given the inputs. Computes avgLen locally
// from the candidate set — no global scan.
export function rankCandidates(
  candidates: { record: MessageRecord; lineCwd?: string }[],
  queryTerms: string[],
  sessionCwd?: string,
): RankedResult[] {
  let totalLen = 0;
  for (const c of candidates) totalLen += tokenize(c.record.text).length;
  const avgLen = candidates.length > 0 ? totalLen / candidates.length : 0;

  const seen = new Set<string>();
  const scored: RankedResult[] = [];
  for (const c of candidates) {
    const key = c.record.lineKey;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({
      record: c.record,
      lineCwd: c.lineCwd,
      score: scoreLine(c.record, queryTerms, avgLen, c.lineCwd, sessionCwd),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Extract the file path from a "path:line" lineKey. Used for diversity capping
// and cwd lookup. Safe because we control lineKey construction (normalize.ts).
export function filePathOf(lineKey: string): string {
  const i = lineKey.lastIndexOf(":");
  return i > 0 ? lineKey.slice(0, i) : lineKey;
}

// Spread results across files: keep at most `maxPerFile` from any one session,
// preserving the (score-sorted) input order.
export function diversityCap<T extends { record: MessageRecord }>(
  items: T[],
  maxPerFile: number,
): T[] {
  const perFile = new Map<string, number>();
  const out: T[] = [];
  for (const r of items) {
    const file = filePathOf(r.record.lineKey);
    const count = perFile.get(file) ?? 0;
    if (count >= maxPerFile) continue;
    perFile.set(file, count + 1);
    out.push(r);
  }
  return out;
}
