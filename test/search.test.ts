import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  search,
  buildSearchResults,
  parseRgJson,
  runRipgrep,
  MAX_RESULTS,
  PER_FILE_CAP,
  type RgMatch,
  type RgRunner,
} from "../src/search";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

// --- Fixture: a small Pi-format session tree ---

const SESSION_DOCS =
  '{"type":"session","version":3,"id":"a","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/proj/a"}\n' +
  '{"type":"message","id":"u1","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"fix the docker compose deployment bug"}]}}\n' +
  '{"type":"message","id":"a1","timestamp":"2026-07-01T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"configure the k3s cluster"}]}}\n' +
  '{"type":"message","id":"t1","timestamp":"2026-07-01T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":"docker output here"}}\n' +
  '{"type":"custom_message","customType":"chrollo","content":"injected noise about docker","timestamp":"2026-07-01T10:00:04.000Z"}\n';

function makeTree(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-search-"));
  fs.mkdirSync(path.join(tmp, "projA"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "projA", "s.jsonl"), SESSION_DOCS, "utf-8");
  return tmp;
}

// Helper: extract 1-based line N from a multiline string.
function line(s: string, n: number): string {
  return s.split("\n")[n - 1] ?? "";
}

// --- parseRgJson (pure) ---

describe("parseRgJson", () => {
  it("extracts match events into RgMatch", () => {
    const stdout = JSON.stringify({
      type: "match",
      data: { path: { text: "/p/s.jsonl" }, line_number: 7, lines: { text: "hit here" } },
    });
    expect(parseRgJson(stdout)).toEqual([{ path: "/p/s.jsonl", line: 7, text: "hit here" }]);
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
    expect(parseRgJson(stdout)).toHaveLength(1);
  });

  it("strips a trailing newline from match text", () => {
    const stdout = JSON.stringify({
      type: "match",
      data: { path: { text: "/p" }, line_number: 1, lines: { text: "text\n" } },
    });
    expect(parseRgJson(stdout)[0].text).toBe("text");
  });
});

// --- buildSearchResults (pure given matches; no ranking) ---

describe("buildSearchResults — structural filtering", () => {
  const root = makeTree();
  const p = path.join(root, "projA", "s.jsonl");

  it("includes user + assistant message lines", async () => {
    const out = await buildSearchResults([
      { path: p, line: 2, text: line(SESSION_DOCS, 2) },
      { path: p, line: 3, text: line(SESSION_DOCS, 3) },
    ]);
    expect(out.some((r) => r.includes("fix the docker compose"))).toBe(true);
    expect(out.some((r) => r.includes("configure the k3s"))).toBe(true);
  });

  it("excludes toolResult lines (tool outputs)", async () => {
    const out = await buildSearchResults([{ path: p, line: 4, text: line(SESSION_DOCS, 4) }]);
    expect(out).toHaveLength(0);
  });

  it("excludes custom_message lines (no self-pollution)", async () => {
    const out = await buildSearchResults([{ path: p, line: 5, text: line(SESSION_DOCS, 5) }]);
    expect(out).toHaveLength(0);
  });

  it("excludes the session header line", async () => {
    const out = await buildSearchResults([{ path: p, line: 1, text: line(SESSION_DOCS, 1) }]);
    expect(out).toHaveLength(0);
  });
});

describe("buildSearchResults — formatting & caps", () => {
  const root = makeTree();
  const p = path.join(root, "projA", "s.jsonl");

  it("returns `path:line | role: preview` formatted lines", async () => {
    const out = await buildSearchResults([{ path: p, line: 2, text: line(SESSION_DOCS, 2) }]);
    expect(out[0]).toMatch(/projA[\\/]s\.jsonl:2 \| user: fix the docker compose/);
  });

  it("respects the per-file diversity cap and MAX_RESULTS", async () => {
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
    const out = await buildSearchResults(matches);
    expect(out).toHaveLength(PER_FILE_CAP); // 3 from one file, capped
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

  it("returns [] when rg finds no matches (no typo fallback)", async () => {
    const root = makeTree();
    const stub: RgRunner = async () => [];
    expect(await search("definitelynotaterm", { root, runRg: stub })).toEqual([]);
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
    const withExclude = await search("docker", { root, runRg: stub, excludePath: target });
    const withoutExclude = await search("docker", { root, runRg: stub });
    expect(withoutExclude.length).toBeGreaterThan(withExclude.length);
    expect(withExclude.every((r) => !r.includes("projA/s.jsonl"))).toBe(true);
  });

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
});

// --- runRipgrep: real rg runner, signal/timeout wiring ---

describe("runRipgrep — signal, timeout, abort, no-match", () => {
  function mockCall(err: unknown, res?: { stdout?: string }): ReturnType<typeof vi.fn> {
    const fn = execFile as ReturnType<typeof vi.fn>;
    fn.mockImplementation((_file, _args, _opts, cb) => {
      cb(err, res ?? { stdout: "" });
      return undefined;
    });
    return fn;
  }

  beforeEach(() => vi.clearAllMocks());

  it("passes abort signal + timeout + maxBuffer to execFile", async () => {
    const fn = mockCall(null, { stdout: "" });
    const ac = new AbortController();
    await runRipgrep(["docker"], "/tmp/root", ac.signal);
    const [, , opts] = fn.mock.calls[0];
    expect(opts.signal).toBe(ac.signal);
    expect(opts.timeout).toBe(30000);
    expect(opts.maxBuffer).toBe(100 * 1024 * 1024);
  });

  it("abort (AbortError) -> returns [], not an error", async () => {
    mockCall({ name: "AbortError" });
    const ac = new AbortController();
    ac.abort();
    expect(await runRipgrep(["docker"], "/tmp/root", ac.signal)).toEqual([]);
  });

  it("timeout kill with no result -> throws honest 'search timed out'", async () => {
    mockCall({ killed: true, signal: "SIGTERM", stdout: "" });
    await expect(runRipgrep(["docker"], "/tmp/root")).rejects.toThrow("search timed out");
  });

  it("no-match (exit 1) -> [] (not an error)", async () => {
    mockCall({ code: 1 }, { stdout: "" });
    expect(await runRipgrep(["docker"], "/tmp/root")).toEqual([]);
  });
});

describe("constants", () => {
  it("MAX_RESULTS and PER_FILE_CAP are sensible", () => {
    expect(MAX_RESULTS).toBe(15);
    expect(PER_FILE_CAP).toBe(3);
  });
});
