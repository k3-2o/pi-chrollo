// --- Chrollo Access Tracking (Phase 10B) ---
//
// Tracks when each memory line was last referenced (read via read_memory or
// surfaced for injection). Used to reinforce recency: a memory you keep coming
// back to stays accessible longer than one you wrote once and forgot.
//
// Stored at .chrollo/access.json — a flat map of "file:line" -> ISO timestamp.
// SYNCHRONOUS I/O (learned the async lesson): the file is small (~KB, not the
// full corpus), so readFileSync/writeFileSync are fine on the hot path. This is
// a derived cache — deletable, never the source of truth. The verbatim memory
// files are never modified by this module.

import * as fs from "node:fs";
import * as path from "node:path";
import { getMemoriesDir } from "./storage.js";

// In-memory cache. Loaded lazily on first access, reused for the session.
let _accessCache: Map<string, Date> | null = null;

function accessPath(): string {
  // parent of the memories dir = the .chrollo/ root
  return path.join(path.dirname(getMemoriesDir()), "access.json");
}

// --- Load the access map (synchronous, cached after first call within a
//     session). Best-effort: missing/corrupt file -> empty map.
export function getAccessMap(): Map<string, Date> {
  if (_accessCache !== null) return _accessCache;
  try {
    const raw = fs.readFileSync(accessPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    _accessCache = new Map();
    for (const [k, v] of Object.entries(parsed)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) _accessCache.set(k, d);
    }
  } catch {
    _accessCache = new Map();
  }
  return _accessCache;
}

// --- Look up the last-referenced time for a key. Returns undefined if the
//     line was never referenced (falls back to creation-date decay).
export function getLastReferenced(key: string): Date | undefined {
  return getAccessMap().get(key);
}

// --- Record that these keys were referenced NOW. Updates the in-memory cache
//     AND persists to disk (best-effort — write failures are swallowed so a
//     metrics problem can never break the search path).
export function recordAccess(keys: string[]): void {
  if (keys.length === 0) return;
  const map = getAccessMap();
  const now = new Date();
  for (const k of keys) map.set(k, now);
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of map) obj[k] = v.toISOString();
    fs.mkdirSync(path.dirname(accessPath()), { recursive: true });
    fs.writeFileSync(accessPath(), JSON.stringify(obj), "utf-8");
  } catch {
    // best-effort: in-memory cache still updated; just not persisted
  }
}

// --- Drop the in-memory cache. Called at session_shutdown (like corpus freq).
export function invalidateAccessCache(): void {
  _accessCache = null;
}
