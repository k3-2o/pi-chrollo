// Chrollo Access Tracking (Phase 10B). Tracks when each memory line was last
// referenced. Stored at .chrollo/access.json — flat map of file:line -> ISO
// timestamp. Synchronous I/O (the file is small; async conversion broke
// handler atomicity in 0.2.0). Deletable derived cache — memory files never
// modified by this module.

import * as fs from "node:fs";
import * as path from "node:path";
import { getMemoriesDir } from "./storage.js";

let _accessCache: Map<string, Date> | null = null;

function accessPath(): string {
  return path.join(path.dirname(getMemoriesDir()), "access.json");
}

// Load access map (synchronous, cached after first call). Missing/corrupt file -> empty map.
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

// Look up last-referenced time for a key (undefined = never referenced).
export function getLastReferenced(key: string): Date | undefined {
  return getAccessMap().get(key);
}

// Record reference NOW for these keys. Updates in-memory cache and persists
// to disk (best-effort — write failures swallowed).
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
    // best-effort: in-memory cache still updated
  }
}

// Drop in-memory cache. Called at session_shutdown.
export function invalidateAccessCache(): void {
  _accessCache = null;
}
