import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  discoverSessions,
  computeStats,
  getCorpusStats,
  invalidateCorpusCache,
  defaultRoot,
} from "../src/corpus";

// Build an isolated tmp session tree per test. Returns the root + helpers.
function makeTree(): { root: string; writeFile: (rel: string, content: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-corpus-"));
  const writeFile = (rel: string, content: string): string => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return full;
  };
  return { root, writeFile };
}

// A minimal Pi-format session with two message lines + noise lines.
const SESSION_A =
  '{"type":"session","version":3,"id":"a","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/proj/a"}\n' +
  '{"type":"model_change","id":"m","parentId":null,"timestamp":"2026-07-01T10:00:00.500Z","provider":"p","modelId":"x"}\n' +
  '{"type":"message","id":"u1","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"fix the docker compose deployment"}]}}\n' +
  '{"type":"message","id":"a1","timestamp":"2026-07-01T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"configure the k3s cluster"}]}}\n' +
  '{"type":"message","id":"t1","timestamp":"2026-07-01T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":"out"}}\n';

beforeEach(() => invalidateCorpusCache());
afterEach(() => invalidateCorpusCache());

describe("discoverSessions", () => {
  it("finds *.jsonl files recursively", () => {
    const { root, writeFile } = makeTree();
    writeFile("projA/2026-07-01_a.jsonl", SESSION_A);
    writeFile("projB/sub/2026-07-02_b.jsonl", SESSION_A);
    writeFile("projA/notes.md", "# not a session");
    const found = discoverSessions(root);
    expect(found).toHaveLength(2);
    expect(found.every((p) => p.endsWith(".jsonl"))).toBe(true);
  });

  it("returns [] for a nonexistent root", () => {
    expect(discoverSessions(path.join(os.tmpdir(), "definitely-not-here-xyz"))).toEqual([]);
  });

  it("returns [] for an empty root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-empty-"));
    expect(discoverSessions(root)).toEqual([]);
  });

  it("returns sorted paths", () => {
    const { root, writeFile } = makeTree();
    writeFile("z/1.jsonl", SESSION_A);
    writeFile("a/2.jsonl", SESSION_A);
    const found = discoverSessions(root);
    expect(found).toEqual([...found].sort());
  });
});

describe("computeStats", () => {
  it("counts message lines only (skips toolResult, model_change, session)", () => {
    const { root, writeFile } = makeTree();
    writeFile("projA/s.jsonl", SESSION_A);
    const stats = computeStats(discoverSessions(root));
    // 2 message lines (user + assistant); toolResult/model_change/session skipped
    expect(stats.totalDocs).toBe(2);
  });

  it("builds docFreq over message-line terms", () => {
    const { root, writeFile } = makeTree();
    writeFile("projA/s.jsonl", SESSION_A);
    const stats = computeStats(discoverSessions(root));
    expect(stats.docFreq.get("docker")).toBe(1);
    expect(stats.docFreq.get("compose")).toBe(1);
    expect(stats.docFreq.get("cluster")).toBe(1);
  });

  it("counts a term once per line even if it repeats within the line", () => {
    const { root, writeFile } = makeTree();
    writeFile(
      "projA/s.jsonl",
      '{"type":"message","timestamp":"2026-07-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"docker docker docker"}]}}\n',
    );
    const stats = computeStats(discoverSessions(root));
    expect(stats.docFreq.get("docker")).toBe(1); // 1 document, not 3 occurrences
  });

  it("computes avgLen from full token counts (with duplicates)", () => {
    const { root, writeFile } = makeTree();
    writeFile(
      "projA/s.jsonl",
      '{"type":"message","timestamp":"2026-07-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"docker docker"}]}}\n' +
        '{"type":"message","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"alpha"}]}}\n',
    );
    const stats = computeStats(discoverSessions(root));
    // line1: [docker, docker] len 2 ; line2: [alpha] len 1 ; avg = 1.5
    expect(stats.avgLen).toBeCloseTo(1.5, 5);
  });

  it("extracts cwd from each session header into fileCwd", () => {
    const { root, writeFile } = makeTree();
    const a = writeFile("projA/s.jsonl", SESSION_A);
    const stats = computeStats(discoverSessions(root));
    expect(stats.fileCwd.get(a)).toBe("/proj/a");
  });

  it("returns zeroed stats for an empty corpus", () => {
    const stats = computeStats([]);
    expect(stats.totalDocs).toBe(0);
    expect(stats.avgLen).toBe(0);
    expect(stats.docFreq.size).toBe(0);
    expect(stats.fileCwd.size).toBe(0);
  });

  it("handles an unreadable file gracefully (skips it)", () => {
    const { root, writeFile } = makeTree();
    writeFile("projA/s.jsonl", SESSION_A);
    const unreadable = path.join(root, "projA/bad.jsonl");
    fs.writeFileSync(unreadable, SESSION_A);
    fs.chmodSync(unreadable, 0o000); // remove read perms
    let stats;
    try {
      stats = computeStats([unreadable, path.join(root, "projA/s.jsonl")]);
    } finally {
      fs.chmodSync(unreadable, 0o644); // restore so cleanup can delete
    }
    // unreadable skipped; the readable one still counted
    expect(stats.totalDocs).toBe(2);
  });
});

describe("getCorpusStats caching", () => {
  it("returns the same object reference on a cache hit", () => {
    const { root, writeFile } = makeTree();
    writeFile("projA/s.jsonl", SESSION_A);
    const s1 = getCorpusStats(root);
    const s2 = getCorpusStats(root);
    expect(s2).toBe(s1); // identical reference — no recompute
  });

  it("recomputes when a file's mtime/size changes", () => {
    const { root, writeFile } = makeTree();
    const file = writeFile("projA/s.jsonl", SESSION_A);
    const s1 = getCorpusStats(root);

    // Change content (size + bump mtime well into the future to be unambiguous).
    fs.writeFileSync(file, SESSION_A + SESSION_A, "utf-8");
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(file, future, future);

    const s2 = getCorpusStats(root);
    expect(s2).not.toBe(s1); // recomputed — new reference
    expect(s2.totalDocs).toBe(4); // doubled content
  });

  it("recomputes when a file is added", () => {
    const { root, writeFile } = makeTree();
    writeFile("projA/s.jsonl", SESSION_A);
    const s1 = getCorpusStats(root);
    expect(s1.totalDocs).toBe(2);

    writeFile("projB/s2.jsonl", SESSION_A);
    const s2 = getCorpusStats(root);
    expect(s2).not.toBe(s1);
    expect(s2.totalDocs).toBe(4);
  });

  it("invalidateCorpusCache forces a recompute on next call", () => {
    const { root, writeFile } = makeTree();
    writeFile("projA/s.jsonl", SESSION_A);
    const s1 = getCorpusStats(root);
    invalidateCorpusCache();
    const s2 = getCorpusStats(root);
    expect(s2).not.toBe(s1); // cache was cleared → fresh compute
    // Values are still equal (same files), just a new object.
    expect(s2.totalDocs).toBe(s1.totalDocs);
  });
});

describe("defaultRoot", () => {
  it("points under ~/.pi/agent/sessions", () => {
    const root = defaultRoot();
    expect(root).toBe(path.join(os.homedir(), ".pi", "agent", "sessions"));
  });
});
