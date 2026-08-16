// Chrollo corpus — minimal. Just locate the session root. There is NO stats
// scan, NO term-frequency dictionary, NO cache, NO mtime invalidation, and no
// per-file cwd reader — the cwd boost that needed those is gone.

import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_ROOT_SEGMENTS = [".pi", "agent", "sessions"];

export function defaultRoot(): string {
  return path.join(os.homedir(), ...DEFAULT_ROOT_SEGMENTS);
}
