// Chrollo format — shared rendering helpers. Both tools produce readable text
// from NormalizedRecords; this is where the "agent never sees raw JSON" promise
// is delivered. No I/O, pure functions.

import type { MessageRecord, CompactionRecord } from "./normalize.js";

const MAX_PREVIEW_LEN = 200;

// Collapse whitespace and trim a one-line preview of a message's text. Keeps
// search results scannable: `path:line | preview`.
function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_PREVIEW_LEN) return collapsed;
  return collapsed.slice(0, MAX_PREVIEW_LEN - 1) + "…";
}

// Render a message line as a search-result one-liner: `path:line | preview`.
// The `path:line` prefix round-trips straight into read's offset param.
export function formatSearchLine(record: MessageRecord): string {
  const text = preview(record.text);
  return `${record.lineKey} | ${record.role}: ${text}`;
}

// Render a toolCall compactly for read output: `> name(args)`. The arg summary
// is deliberately short (first few chars of a stringified representation) so
// toolCall-heavy turns don't drown the readable text. Dumps full args only if
// they are absent or trivial.
function formatToolCall(name: string, args: unknown): string {
  if (args === undefined || args === null) return `> ${name}()`;
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    return `> ${name}(?)`;
  }
  if (s.length > 60) s = s.slice(0, 59) + "…";
  return `> ${name}(${s})`;
}

// Render an epoch-ms timestamp as a compact local HH:MM clock. Returns empty
// string for unknown (0) timestamps.
function clock(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Render a message record for read output. Each text block becomes
// `[HH:MM] role: text`; each toolCall becomes `> name(args)`. Thinking blocks
// are already dropped by normalize, so they never appear here.
export function formatReadMessage(record: MessageRecord): string[] {
  const out: string[] = [];
  const clk = clock(record.timestamp);
  const prefix = clk.length > 0 ? `[${clk}] ` : "";
  if (record.text.length > 0) {
    out.push(`${prefix}${record.role}: ${record.text}`);
  }
  for (const tc of record.toolCalls) {
    out.push(formatToolCall(tc.name, tc.args));
  }
  return out;
}

// Render a compaction boundary as a gap marker so a read window crossing one
// is visibly discontinuous.
export function formatCompactionGap(_record: CompactionRecord): string {
  return "[...context compacted — earlier turns summarized away...]";
}
