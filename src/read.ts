// Chrollo read — renders a window of a session file readably. Validates the
// search-then-read contract: `offset` is REQUIRED (no whole-file reads) and
// `limit` is capped so the agent can never dump raw JSONL into context.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseLine } from "./normalize.js";
import { formatReadMessage, formatCompactionGap } from "./format.js";
import { defaultRoot } from "./corpus.js";

export const READ_LIMIT_DEFAULT = 10;
export const READ_LIMIT_CAP = 50;

// Check whether a path lives under the session root. Read rejects anything
// outside it — the agent can't be tricked into reading arbitrary files.
function isSessionPath(target: string, root: string): boolean {
  const resolved = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface ReadResult {
  text: string;
  lines: number; // lines actually rendered
  truncated: boolean; // true if limit was hit mid-window
}

// Read a window [offset, offset+limit) of a session file and render it.
// 1-based line numbers, matching what search's `path:line` markers carry.
// Returns an error string (not a throw) when validation fails, so the tool
// layer can surface it cleanly.
export function read(
  filePath: string,
  offset: number,
  limit: number = READ_LIMIT_DEFAULT,
  root: string = defaultRoot(),
): ReadResult | { error: string } {
  if (!isSessionPath(filePath, root)) {
    return { error: `path is outside the session store: ${filePath}` };
  }
  if (!fs.existsSync(filePath)) {
    return { error: `session file not found: ${filePath}` };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return { error: `unreadable session file: ${(e as Error).message}` };
  }

  const allLines = content.split("\n");
  // rg/JSONL lines are 1-based; normalize to a 0-based slice.
  const start = Math.max(0, offset - 1);
  if (start >= allLines.length) {
    return { text: "", lines: 0, truncated: false };
  }
  const cappedLimit = Math.min(limit, READ_LIMIT_CAP);
  const slice = allLines.slice(start, start + cappedLimit);

  const out: string[] = [];
  for (let i = 0; i < slice.length; i++) {
    const raw = slice[i];
    const lineNo = start + i + 1;
    if (raw.length === 0) continue;
    const rec = parseLine(filePath, lineNo, raw);
    if (rec === null) continue; // unparseable — skip, never crash
    if (rec.kind === "compaction") {
      out.push(formatCompactionGap(rec));
    } else if (rec.kind === "message") {
      out.push(...formatReadMessage(rec));
    }
    // skip records (session header, model_change, toolResult, …) render nothing
  }

  return {
    text: out.join("\n"),
    lines: out.length,
    truncated: slice.length === cappedLimit && start + cappedLimit < allLines.length,
  };
}
