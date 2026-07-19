import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { computeCorpusFrequency, invalidateCorpusCache } from "../src/search";
import { setActiveMemoriesDir } from "../src/storage";

// Corpus cache: SYNCHRONOUS module-level cache, computed once per session,
// reused for every prompt. Reverted from the async/persisted design (which
// broke atomicity and froze the prompt box).

let tmpRoot: string;
let memDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-freq-"));
  memDir = path.join(tmpRoot, ".chrollo", "memories");
  fs.mkdirSync(memDir, { recursive: true });
  setActiveMemoriesDir(tmpRoot);
  invalidateCorpusCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  invalidateCorpusCache();
});

function writeMem(name: string, body: string): void {
  fs.writeFileSync(path.join(memDir, name), body);
}

describe("computeCorpusFrequency — module cache", () => {
  it("is SYNCHRONOUS (returns the value directly, not a promise)", () => {
    writeMem("2026-06-01_100000_aaaaaaaa.md", "alpha beta");
    const res = computeCorpusFrequency();
    // sync contract: not a promise
    expect(res.freq).toBeInstanceOf(Map);
    expect(typeof res.totalFiles).toBe("number");
  });

  it("returns cached values on a second call without re-reading files", () => {
    writeMem("2026-06-01_100000_aaaaaaaa.md", "alpha alpha beta content here");
    computeCorpusFrequency();

    // Mutate the corpus after the cache is warm, WITHOUT invalidating.
    writeMem("2026-06-02_100000_bbbbbbbb.md", "completely new words zeta theta");
    const stale = computeCorpusFrequency();

    // Still cached: the new file's words are NOT present.
    expect(stale.freq.has("zeta")).toBe(false);
    expect(stale.totalFiles).toBe(1); // not recounted
  });

  it("invalidateCorpusCache() forces a fresh read that sees new files", () => {
    writeMem("2026-06-01_100000_aaaaaaaa.md", "alpha alpha beta content here");
    computeCorpusFrequency();

    writeMem("2026-06-02_100000_bbbbbbbb.md", "completely new words zeta theta");
    invalidateCorpusCache();
    const fresh = computeCorpusFrequency();

    expect(fresh.freq.has("zeta")).toBe(true);
    expect(fresh.freq.has("theta")).toBe(true);
    expect(fresh.totalFiles).toBe(2);
  });

  it("returns empty map for an empty memories dir", () => {
    const res = computeCorpusFrequency();
    expect(res.freq.size).toBe(0);
    expect(res.totalFiles).toBe(0);
  });

  it("tokenizes content (split identifiers count as separate words)", () => {
    writeMem("2026-06-01_100000_aaaaaaaa.md", "the getUserProfile function");
    const { freq } = computeCorpusFrequency();
    // tokenize splits getUserProfile -> get, user, profile
    expect(freq.has("user")).toBe(true);
    expect(freq.has("profile")).toBe(true);
  });
});
