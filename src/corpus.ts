// Chrollo corpus — minimal. NO global stats scan, NO term-frequency dictionary,
// NO cache, NO mtime invalidation. All of that was the 13s-freeze bug (SPEC
// §3.3) and is permanently gone.
//
// This module now does only two cheap things: locate the session root, and
// read a single session file's cwd from its header (for the same-project
// ranking boost). Both are O(1) — no per-search corpus work.

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { extractSessionCwd } from "./normalize.js";

const DEFAULT_ROOT_SEGMENTS = [".pi", "agent", "sessions"];

export function defaultRoot(): string {
  return path.join(os.homedir(), ...DEFAULT_ROOT_SEGMENTS);
}

// Read a session file's cwd from its header. The session header is always line
// 1 (verified), so we read only the first chunk of the file — not the whole
// thing. Called only for files that already have search matches (≤ ~15), so
// the total cost is tiny and never blocks the UI.
export function readSessionCwd(filePath: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, 8192, 0);
    const head = buf.subarray(0, bytes).toString("utf-8");
    // Header is line 1, but scan the first few lines defensively.
    for (const line of head.split("\n").slice(0, 5)) {
      const cwd = extractSessionCwd(line);
      if (cwd !== undefined) return cwd;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}
