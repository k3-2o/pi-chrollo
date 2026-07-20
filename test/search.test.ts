import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  search,
  buildSearchResults,
  parseRgJson,
  MAX_RESULTS,
  PER_FILE_CAP,
  type RgMatch,
  type RgRunner,
} from "../src/search";
// (No corpus cache to invalidate — the stats scan is gone, SPEC §3.3.)

// --- Fixture: a small Pi-format session tree ---

const SESSION_DOCS =
  '{"type":"session","version":3,"id":"a","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/proj/a"}\n' +
  '{"type":"message","id":"u1","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"fix the docker compose deployment bug"}]}}\n' +
  '{"type":"message","id":"a1","timestamp":"2026-07-01T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"configure the k3s cluster"}]}}\n' +
  '{"type":"message","id":"t1","timestamp":"2026-07-01T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":"docker output here"}}\n' +
  '{"type":"custom_message","customType":"chrollo","content":"injected noise about docker","timestamp":"2026-07-01T10:00:04.000Z"}\n';

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-search-"));
  fs.mkdirSync(path.join(root, "projA"), { recursive: true });
  fs.writeFileSync(path.join(root, "projA", "s.jsonl"), SESSION_DOCS, "utf-8");
  return root;
}

// (No corpus cache to clear between tests — the stats scan is gone, SPEC §3.3.)

// --- parseRgJson (pure) ---

describe("parseRgJson", () => {
  it("extracts match events into RgMatch", () => {
    const stdout = JSON.stringify({
      type: "match",
      data: { path: { text: "/p/s.jsonl" }, line_number: 7, lines: { text: "hit here" } },
    });
    const out = parseRgJson(stdout);
    expect(out).toEqual([{ path: "/p/s.jsonl", line: 7, text: "hit here" }]);
  });

  it("skips non-match events (begin/end/summary)", () => {
    const stdout =
      JSON.stringify({ type: "begin", data: { path: { text: "/p/s.jsonl" } } }) +
      "\n" +
      JSON.stringify({ type: "summary", data: { stats: { matches: 1 } } });
    expect(parseRgJson(stdout)).toEqual([]);
  });

  it("skips malformed JSON lines", () => {
    const stdout = "not json\n" + JSON.stringify({ type: "match", data: {} });
    expect(parseRgJson(stdout)).toHaveLength(1); // bad line skipped, good one kept
  });

  it("strips a trailing newline from match text", () => {
    const stdout = JSON.stringify({
      type: "match",
      data: { path: { text: "/p" }, line_number: 1, lines: { text: "text\n" } },
    });
    expect(parseRgJson(stdout)[0].text).toBe("text");
  });
});

// --- buildSearchResults (pure given matches) ---

// buildSearchResults no longer takes corpus stats (SPEC §3.3). It reads
// per-file cwds lazily from the fixture files themselves.

describe("buildSearchResults — structural filtering", () => {
  it("includes user + assistant message lines", () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 2, text: line(SESSION_DOCS, 2) },
      { path: path.join(root, "projA", "s.jsonl"), line: 3, text: line(SESSION_DOCS, 3) },
    ];
    const out = buildSearchResults(matches, ["docker"]);
    expect(out.some((r) => r.includes("fix the docker compose"))).toBe(true);
    expect(out.some((r) => r.includes("configure the k3s"))).toBe(true);
  });

  it("excludes toolResult lines (tool outputs)", () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 4, text: line(SESSION_DOCS, 4) },
    ];
    const out = buildSearchResults(matches, ["docker"]);
    expect(out).toHaveLength(0); // the only match was a toolResult -> dropped
  });

  it("excludes custom_message lines (no self-pollution)", () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 5, text: line(SESSION_DOCS, 5) },
    ];
    const out = buildSearchResults(matches, ["docker"]);
    expect(out).toHaveLength(0); // chrollo self-injection dropped
  });

  it("excludes the session header line", () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 1, text: line(SESSION_DOCS, 1) },
    ];
    expect(buildSearchResults(matches, ["docker"])).toHaveLength(0);
  });
});

describe("buildSearchResults — ranking & formatting", () => {
  it("returns `path:line | role: preview` formatted lines", () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 2, text: line(SESSION_DOCS, 2) },
    ];
    const out = buildSearchResults(matches, ["docker"]);
    expect(out[0]).toMatch(/projA.s.jsonl:2 \| user: fix the docker compose/);
  });

  it("respects the per-file diversity cap", () => {
    const root = makeTree();
    // All 5 lines from one file — only 2 are message lines (lines 2, 3),
    // so with cap 3 we'd get 2. Build a fatter fixture to test the cap.
    const fatPath = path.join(root, "fat.jsonl");
    const fat =
      Array.from({ length: 6 }, (_, i) =>
        JSON.stringify({
          type: "message",
          timestamp: "2026-07-01T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: `docker hit ${i}` }] },
        }),
      ).join("\n") + "\n";
    fs.writeFileSync(fatPath, fat);
    const matches: RgMatch[] = Array.from({ length: 6 }, (_, i) => ({
      path: fatPath,
      line: i + 1,
      text: line(fat, i + 1),
    }));
    const out = buildSearchResults(matches, ["docker"], undefined, {
      perFileCap: 3,
    });
    expect(out).toHaveLength(3); // capped at 3 from one file
  });
});

// --- search() end-to-end with a stubbed rg runner ---

describe("search — end-to-end (stubbed rg)", () => {
  it("returns formatted results when rg finds matches", async () => {
    const root = makeTree();
    const stub: RgRunner = async () => [
      { path: path.join(root, "projA", "s.jsonl"), line: 2, text: line(SESSION_DOCS, 2) },
    ];
    const out = await search("docker deployment", { root, runRg: stub });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatch(/docker compose/);
  });

  it("returns [] for an empty/trivial query (no tokens)", async () => {
    const root = makeTree();
    const stub: RgRunner = async () => [];
    expect(await search("the a an", { root, runRg: stub })).toEqual([]);
    expect(await search("", { root, runRg: stub })).toEqual([]);
  });

  it("triggers the trigram fallback when the first pass returns nothing", async () => {
    const root = makeTree();
    let calls = 0;
    let secondCallPatterns: string[] = [];
    const stub: RgRunner = async (patterns) => {
      calls++;
      if (calls === 2) secondCallPatterns = patterns;
      return calls === 1
        ? []
        : [{ path: path.join(root, "projA", "s.jsonl"), line: 2, text: line(SESSION_DOCS, 2) }];
    };
    // 'dockerx' (>= 4 chars) yields trigrams; first pass misses, fallback hits.
    const out = await search("dockerx", { root, runRg: stub });
    expect(calls).toBe(2); // fallback fired
    expect(secondCallPatterns.length).toBeGreaterThan(0);
    expect(secondCallPatterns.some((p) => p.includes("("))).toBe(true); // regex form
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not fire fallback if no term yields trigrams", async () => {
    const root = makeTree();
    let calls = 0;
    const stub: RgRunner = async () => {
      calls++;
      return [];
    };
    // 'cat' is 3 chars -> trigramRegex returns null (needs >= 4)
    expect(await search("cat", { root, runRg: stub })).toEqual([]);
    expect(calls).toBe(1); // no fallback
  });

  it("returns [] when both passes miss", async () => {
    const root = makeTree();
    const stub: RgRunner = async () => [];
    expect(await search("nonexistentterm", { root, runRg: stub })).toEqual([]);
  });
});

describe("constants", () => {
  it("MAX_RESULTS and PER_FILE_CAP are sensible", () => {
    expect(MAX_RESULTS).toBe(15);
    expect(PER_FILE_CAP).toBe(3);
  });
});

// Helper: extract 1-based line N from a multiline string.
function line(s: string, n: number): string {
  return s.split("\n")[n - 1] ?? "";
}
