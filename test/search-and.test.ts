import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { singlePassAndSearch, grepSearch, invalidateCorpusCache } from "../src/search";
import { setActiveMemoriesDir } from "../src/storage";

// Integration tests for the single-pass AND search (AD-4) against a temp
// memories dir with fixture .md files. Uses real ripgrep.

let tmpRoot: string;
let memDir: string;

const FIXTURES = {
  // has alpha + beta + gamma
  fileA: `[2026-06-01 10:00:00] [User]
we discussed the alpha and beta approach here, with some gamma context
`,
  // has alpha + gamma, NOT beta
  fileB: `[2026-06-02 10:00:00] [User]
alpha showed up here too, and gamma, nothing else relevant
`,
  // has beta only
  fileC: `[2026-06-03 10:00:00] [User]
just a beta mention on its own
`,
  // unrelated noise
  fileD: `[2026-06-04 10:00:00] [User]
completely unrelated prose about nothing relevant
`,
};

function writeFixture(name: string, body: string): void {
  // filename must match the YYYY-MM-DD_HHMMSS_<hex>.md pattern so it's a valid memory file
  fs.writeFileSync(path.join(memDir, `2026-06-0${name}_100000_${name.toLowerCase()}aa.md`), body);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-test-"));
  memDir = path.join(tmpRoot, ".chrollo", "memories");
  fs.mkdirSync(memDir, { recursive: true });
  writeFixture("1", FIXTURES.fileA);
  writeFixture("2", FIXTURES.fileB);
  writeFixture("3", FIXTURES.fileC);
  writeFixture("4", FIXTURES.fileD);
  // Point chrollo at our temp corpus.
  setActiveMemoriesDir(tmpRoot);
  // Fresh corpus cache per test (persists to disk; avoid cross-test staleness).
  invalidateCorpusCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  invalidateCorpusCache();
});

describe("singlePassAndSearch", () => {
  it("AND: only files containing ALL terms match", async () => {
    const { files } = await singlePassAndSearch(["alpha", "beta"]);
    // fileA has both; fileB has alpha but not beta; fileC has beta but not alpha
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("aa.md");
  });

  it("single term returns every file with that term", async () => {
    const { files } = await singlePassAndSearch(["alpha"]);
    expect(files).toHaveLength(2); // fileA + fileB
  });

  it("three-term AND narrows to the one file with all three", async () => {
    const { files } = await singlePassAndSearch(["alpha", "beta", "gamma"]);
    expect(files).toHaveLength(1); // only fileA
  });

  it("returns the matching lines (not just files) — the free byproduct of one pass", async () => {
    const { lines } = await singlePassAndSearch(["alpha", "beta"]);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // every returned line is from an AND-passing file (fileA)
    expect(lines.every((l) => l.sourcePath.includes("aa.md"))).toBe(true);
    // matchedTerms populated from submatches
    expect(lines[0].matchedTerms.length).toBeGreaterThan(0);
    expect(lines[0].matchedTerms.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it("returns empty when a term appears in NO file", async () => {
    const { files, lines } = await singlePassAndSearch(["alpha", "nonexistentterm"]);
    expect(files).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("returns empty for an empty terms list", async () => {
    const { files, lines } = await singlePassAndSearch([]);
    expect(files).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("does not return tool-call lines (isToolLine filter holds)", async () => {
    // add a file whose only matching line is a tool line
    fs.writeFileSync(
      path.join(memDir, "2026-06-05_100000_aaaaaabb.md"),
      `[2026-06-05 10:00:00] [Agent]\n> <tool>$ alpha and beta command</tool>\n`,
    );
    const { lines } = await singlePassAndSearch(["alpha", "beta"]);
    // the tool line must be filtered out; only fileA's prose line remains
    expect(lines.every((l) => !l.text.includes("<tool>"))).toBe(true);
  });
});

describe("grepSearch (single-pass AND via public API)", () => {
  it("returns ranked results for a query whose terms co-occur", async () => {
    // "alpha beta" both appear in fileA; grepSearch extracts distinctive terms.
    // (These tokens are rare enough across 4 files to survive the corpus filter
    // or fall through to the raw fallback — either way the AND runs.)
    const res = await grepSearch("alpha beta");
    expect(res.layer).toBe("and");
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    expect(res.results.every((r) => r.sourcePath.includes("aa.md"))).toBe(true);
  });

  it("returns empty (not junk) when no file has all terms", async () => {
    const res = await grepSearch("alpha nonexistentterm");
    expect(res.results).toEqual([]);
    expect(res.layer).toBe("and"); // never "and+thesaurus" anymore (AD-7)
    expect(res.totalMatches).toBe(0);
  });
});
