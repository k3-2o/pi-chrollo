import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  search,
  buildSearchResults,
  parseRgJson,
  rgCatch,
  SearchInterruptedError,
  runRipgrep,
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
  it("includes user + assistant message lines", async () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 2, text: line(SESSION_DOCS, 2) },
      { path: path.join(root, "projA", "s.jsonl"), line: 3, text: line(SESSION_DOCS, 3) },
    ];
    const out = await buildSearchResults(matches, ["docker"]);
    expect(out.some((r) => r.includes("fix the docker compose"))).toBe(true);
    expect(out.some((r) => r.includes("configure the k3s"))).toBe(true);
  });

  it("excludes toolResult lines (tool outputs)", async () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 4, text: line(SESSION_DOCS, 4) },
    ];
    const out = await buildSearchResults(matches, ["docker"]);
    expect(out).toHaveLength(0); // the only match was a toolResult -> dropped
  });

  it("excludes custom_message lines (no self-pollution)", async () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 5, text: line(SESSION_DOCS, 5) },
    ];
    const out = await buildSearchResults(matches, ["docker"]);
    expect(out).toHaveLength(0); // chrollo self-injection dropped
  });

  it("excludes the session header line", async () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 1, text: line(SESSION_DOCS, 1) },
    ];
    expect(await buildSearchResults(matches, ["docker"])).toHaveLength(0);
  });
});

describe("buildSearchResults — ranking & formatting", () => {
  it("returns `path:line | role: preview` formatted lines", async () => {
    const root = makeTree();
    const matches: RgMatch[] = [
      { path: path.join(root, "projA", "s.jsonl"), line: 2, text: line(SESSION_DOCS, 2) },
    ];
    const out = await buildSearchResults(matches, ["docker"]);
    expect(out[0]).toMatch(/projA.s.jsonl:2 \| user: fix the docker compose/);
  });

  it("respects the per-file diversity cap", async () => {
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
    const out = await buildSearchResults(matches, ["docker"], undefined, {
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

  it("excludes the current session file via excludePath", async () => {
    const root = makeTree();
    const target = path.join(root, "projA", "s.jsonl");
    const stub: RgRunner = async () => [
      { path: target, line: 2, text: line(SESSION_DOCS, 2) },
      {
        path: path.join(root, "other.jsonl"),
        line: 1,
        text:
          JSON.stringify({
            type: "message",
            timestamp: "2026-07-01T10:00:00.000Z",
            message: { role: "user", content: [{ type: "text", text: "docker hit" }] },
          }) + "\n",
      },
    ];
    // Without exclusion: both files match. With exclusion: only other.jsonl.
    const withExclude = await search("docker", { root, runRg: stub, excludePath: target });
    const withoutExclude = await search("docker", { root, runRg: stub });
    expect(withoutExclude.length).toBeGreaterThan(withExclude.length);
    expect(withExclude.every((r) => !r.includes("projA/s.jsonl"))).toBe(true);
  });
});

// --- rgCatch: classification of a rejected rg run (the cold-start fix) ---

// A killed rg streams partially-valid match JSON; the tail line is truncated.
const matchJson = JSON.stringify({
  type: "match",
  data: { path: { text: "/p/s.jsonl" }, line_number: 2, lines: { text: "docker hit\n" } },
});
const truncatedTail = `{"type":"match","data":{"path":{"te`; // mid-line kill

// Note: these tests mock node:child_process.execFile ONLY for the runRipgrep
// block at the bottom; the rest of the suite injects `runRg` stubs and never
// touches a real or mocked child process.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
import { execFile } from "node:child_process";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rgCatch — timeout / abort / no-match classification", () => {
  it("salvages completed matches from a timed-out run, skipping the truncated tail", () => {
    const err = {
      killed: true,
      signal: "SIGTERM",
      stdout: `${matchJson}\n${truncatedTail}`,
    };
    expect(rgCatch(err)).toEqual([{ path: "/p/s.jsonl", line: 2, text: "docker hit" }]);
  });

  it("throws SearchInterruptedError when a timed-out run produced nothing salvageable", () => {
    expect(() => rgCatch({ killed: true, signal: "SIGTERM", stdout: "" })).toThrow(
      SearchInterruptedError,
    );
  });

  it("returns [] on user abort (signal) — cancellation, never a fake timeout", () => {
    const ac = new AbortController();
    ac.abort();
    expect(rgCatch({ killed: true, signal: "SIGTERM", stdout: "" }, ac.signal)).toEqual([]);
    expect(() => rgCatch({ killed: true, signal: "SIGTERM", stdout: "" }, ac.signal)).not.toThrow();
  });

  it("returns [] on genuine no-match (rg exit 1) and non-kill errors", () => {
    expect(rgCatch({ code: 1 })).toEqual([]);
    expect(rgCatch(new Error("boom"))).toEqual([]);
    expect(rgCatch(undefined)).toEqual([]);
  });
});

describe("search — signal threading & interruption propagation", () => {
  it("passes the abort signal through to the rg runner", async () => {
    const root = makeTree();
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const stub: RgRunner = async (_p, _r, signal) => {
      seen = signal;
      return [];
    };
    await search("docker", { root, runRg: stub, signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });

  it("propagates SearchInterruptedError so the tool reports a timeout, not 'no memories'", async () => {
    const root = makeTree();
    const stub: RgRunner = async () => {
      throw new SearchInterruptedError(30000);
    };
    await expect(search("docker", { root, runRg: stub })).rejects.toThrow(SearchInterruptedError);
  });
});

describe("runRipgrep — end-to-end via mocked execFile", () => {
  // promisify(execFile) invokes the callback form: (file, args, opts, cb).
  // Mocking with mockResolvedValue hung under bun (promisify didn't adopt the
  // returned promise), so these call the callback directly — the same shape
  // the real promisified call passes.
  function mockCall(err: unknown, res?: { stdout?: string }): ReturnType<typeof vi.fn> {
    const fn = execFile as ReturnType<typeof vi.fn>;
    fn.mockImplementation((_file, _args, _opts, cb) => {
      cb(err, res ?? { stdout: "" });
      return undefined;
    });
    return fn;
  }

  it("salvages partial rg output when killed by the timeout backstop", async () => {
    mockCall({ killed: true, signal: "SIGTERM", stdout: `${matchJson}\n${truncatedTail}` });
    const matches = await runRipgrep(["docker"], "/tmp/root");
    expect(matches).toEqual([{ path: "/p/s.jsonl", line: 2, text: "docker hit" }]);
  });

  it("raises SearchInterruptedError when a killed run had streamed nothing", async () => {
    mockCall({ killed: true, signal: "SIGTERM", stdout: "" });
    await expect(runRipgrep(["docker"], "/tmp/root")).rejects.toThrow(SearchInterruptedError);
  });

  it("returns [] on abort without raising (cancellation is not an error)", async () => {
    mockCall({ name: "AbortError" });
    const ac = new AbortController();
    ac.abort();
    const matches = await runRipgrep(["docker"], "/tmp/root", ac.signal);
    expect(matches).toEqual([]);
  });

  it("passes the abort signal and timeout options to execFile", async () => {
    const fn = mockCall(null, { stdout: "" });
    const ac = new AbortController();
    await runRipgrep(["docker"], "/tmp/root", ac.signal);
    const [, , opts] = fn.mock.calls[0];
    expect(opts.signal).toBe(ac.signal);
    expect(opts.timeout).toBe(30000);
    expect(opts.maxBuffer).toBe(100 * 1024 * 1024);
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
