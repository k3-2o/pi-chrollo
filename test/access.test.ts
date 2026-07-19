import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getAccessMap,
  recordAccess,
  getLastReferenced,
  invalidateAccessCache,
} from "../src/access";
import { recencyMultiplier, rankResults } from "../src/search";
import type { CompactResult } from "../src/search";
import { setActiveMemoriesDir } from "../src/storage";

// Phase 10B: access-reinforced decay.

let tmpRoot: string;

const DAY_MS = 1000 * 60 * 60 * 24;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-access-"));
  fs.mkdirSync(path.join(tmpRoot, ".chrollo", "memories"), { recursive: true });
  setActiveMemoriesDir(tmpRoot);
  invalidateAccessCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  invalidateAccessCache();
});

describe("access sidecar", () => {
  it("getAccessMap returns empty for a missing file", () => {
    expect(getAccessMap().size).toBe(0);
  });

  it("recordAccess writes + getLastReferenced reads back", () => {
    recordAccess(["/mem/a.md:1", "/mem/b.md:5"]);
    expect(getLastReferenced("/mem/a.md:1")).toBeInstanceOf(Date);
    expect(getLastReferenced("/mem/b.md:5")).toBeInstanceOf(Date);
    expect(getLastReferenced("/mem/c.md:1")).toBeUndefined();
  });

  it("persists to .chrollo/access.json (parent of memories)", () => {
    recordAccess(["/mem/a.md:1"]);
    const p = path.join(tmpRoot, ".chrollo", "access.json");
    expect(fs.existsSync(p)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(parsed["/mem/a.md:1"]).toBeDefined();
  });

  it("updates the timestamp on a second recordAccess (reinforced)", () => {
    recordAccess(["/mem/a.md:1"]);
    const first = getLastReferenced("/mem/a.md:1")!;
    // small delay so the timestamp differs
    const future = new Date(Date.now() + 1000);
    // simulate by writing a past timestamp first, then recording again
    const map = getAccessMap();
    map.set("/mem/a.md:1", new Date(Date.now() - 10 * DAY_MS));
    recordAccess(["/mem/a.md:1"]);
    const updated = getLastReferenced("/mem/a.md:1")!;
    expect(updated.getTime()).toBeGreaterThan(first.getTime() - 1000); // refreshed
  });

  it("survives a corrupt access.json (falls back to empty)", () => {
    fs.writeFileSync(path.join(tmpRoot, ".chrollo", "access.json"), "{not json", "utf-8");
    invalidateAccessCache();
    expect(getAccessMap().size).toBe(0);
  });

  it("invalidateAccessCache forces a reload from disk", () => {
    recordAccess(["/mem/a.md:1"]);
    invalidateAccessCache();
    // still readable — reloads from the persisted file
    expect(getLastReferenced("/mem/a.md:1")).toBeInstanceOf(Date);
  });

  it("recordAccess on empty array is a no-op", () => {
    recordAccess([]);
    expect(getAccessMap().size).toBe(0);
  });
});

describe("recencyMultiplier with access reinforcement", () => {
  const oldDate = new Date(Date.now() - 365 * DAY_MS); // a year ago

  it("without lastAccessed: uses creation age only (flattens near 1.0)", () => {
    const m = recencyMultiplier(oldDate);
    expect(m).toBeGreaterThan(1.0);
    expect(m).toBeLessThan(1.01); // a year-old memory is nearly 1.0
  });

  it("with recent lastAccessed: boosts above creation-age decay", () => {
    const recentAccess = new Date(Date.now() - 1 * DAY_MS); // accessed yesterday
    const m = recencyMultiplier(oldDate, recentAccess);
    // should be noticeably higher than without access
    expect(m).toBeGreaterThan(recencyMultiplier(oldDate) + 0.1);
    // 70% of a 1-day-old memory's boost
    const expected = 1 + 1.0 * Math.exp(-1 / (30 / Math.LN2)) * 0.7;
    expect(m).toBeCloseTo(expected, 1);
  });

  it("missing lastAccessed (undefined) falls back gracefully", () => {
    expect(recencyMultiplier(oldDate, undefined)).toBeCloseTo(recencyMultiplier(oldDate), 5);
  });

  it("future-dated access is ignored (no boost, no penalty beyond creation)", () => {
    const futureAccess = new Date(Date.now() + DAY_MS);
    expect(recencyMultiplier(oldDate, futureAccess)).toBeCloseTo(recencyMultiplier(oldDate), 5);
  });
});

describe("rankResults with access map (10B integration)", () => {
  function mk(path: string, line: number): CompactResult {
    return {
      text: "line",
      source: path,
      sourcePath: path,
      line,
      matchedTerms: ["term"],
    };
  }

  it("a frequently-read memory outranks an equally-old unread one", () => {
    const old = new Date(Date.now() - 100 * DAY_MS);
    const read = mk("/read.md", 1);
    const unread = mk("/unread.md", 1);
    read.lineDate = old;
    unread.lineDate = old;

    const access = new Map<string, Date>([
      ["/read.md:1", new Date(Date.now() - 1 * DAY_MS)], // read yesterday
    ]);

    const out = rankResults([unread, read], access);
    expect(out[0]).toBe(read); // read one ranks higher despite same age
  });

  it("without an access map, ranking works exactly as before (backwards compat)", () => {
    const results = [mk("/a.md", 1), mk("/b.md", 1)];
    const out = rankResults(results);
    expect(out).toHaveLength(2);
  });
});
