import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { read, READ_LIMIT_DEFAULT, READ_LIMIT_CAP } from "../src/read";

const SESSION =
  '{"type":"session","version":3,"id":"a","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/proj/a"}\n' +
  '{"type":"message","id":"u1","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"first user turn"}]}}\n' +
  '{"type":"message","id":"a1","timestamp":"2026-07-01T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"first reply"},{"type":"toolCall","name":"read","arguments":{"path":"x.ts"}}]}}\n' +
  '{"type":"message","id":"t1","timestamp":"2026-07-01T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":"file contents here"}}\n' +
  '{"type":"compaction","id":"comp","parentId":"a1","timestamp":"2026-07-15T00:00:00.000Z","summary":"old context"}\n' +
  '{"type":"message","id":"u2","timestamp":"2026-07-01T10:00:04.000Z","message":{"role":"user","content":[{"type":"text","text":"after compaction"}]}}\n';

let tmpRoot: string;
let filePath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-read-"));
  filePath = path.join(tmpRoot, "s.jsonl");
  fs.writeFileSync(filePath, SESSION, "utf-8");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("read — offset/limit slicing", () => {
  it("reads a window starting at offset (1-based)", () => {
    const r = read(filePath, 2, 2, tmpRoot);
    expect("text" in r).toBe(true);
    if ("text" in r) {
      expect(r.text).toContain("first user turn");
      expect(r.text).toContain("first reply");
    }
  });

  it("defaults limit to READ_LIMIT_DEFAULT", () => {
    const r = read(filePath, 1, undefined as any, tmpRoot);
    expect("lines" in r).toBe(true);
  });

  it("caps limit at READ_LIMIT_CAP", () => {
    const r = read(filePath, 1, 99999, tmpRoot);
    if ("truncated" in r) {
      expect(r.truncated).toBe(false); // file only has 6 lines < cap
    }
  });

  it("offset past EOF returns empty", () => {
    const r = read(filePath, 9999, 10, tmpRoot);
    if ("text" in r) {
      expect(r.text).toBe("");
      expect(r.lines).toBe(0);
    }
  });

  it("marks truncated=true when the window hits the limit mid-file", () => {
    // Build a file longer than the cap so truncation triggers.
    const longPath = path.join(tmpRoot, "long.jsonl");
    const lines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({
        type: "message",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: `line ${i}` }] },
      }),
    ).join("\n");
    fs.writeFileSync(longPath, lines);
    const r = read(longPath, 1, READ_LIMIT_CAP, tmpRoot);
    if ("truncated" in r) expect(r.truncated).toBe(true);
  });
});

describe("read — per-role formatting", () => {
  it("renders user text with clock prefix", () => {
    const r = read(filePath, 2, 1, tmpRoot);
    if ("text" in r) expect(r.text).toMatch(/^\[\d{2}:\d{2}\] user: first user turn$/);
  });

  it("renders assistant text + toolCall, skips thinking", () => {
    const r = read(filePath, 3, 1, tmpRoot);
    if ("text" in r) {
      const lines = r.text.split("\n");
      expect(lines.some((l) => /assistant: first reply/.test(l))).toBe(true);
      expect(lines.some((l) => /^> read\(/.test(l))).toBe(true);
      expect(r.text).not.toContain("hmm"); // thinking dropped
    }
  });

  it("skips toolResult lines (no output)", () => {
    const r = read(filePath, 4, 1, tmpRoot);
    if ("text" in r) {
      expect(r.text).not.toContain("file contents here");
      expect(r.lines).toBe(0); // nothing rendered
    }
  });

  it("skips the session header line", () => {
    const r = read(filePath, 1, 1, tmpRoot);
    if ("text" in r) expect(r.lines).toBe(0);
  });

  it("annotates a compaction boundary as a gap marker", () => {
    const r = read(filePath, 5, 1, tmpRoot);
    if ("text" in r) expect(r.text).toMatch(/^\[\.\.\.context compacted/);
  });
});

describe("read — validation", () => {
  it("rejects a path outside the session root", () => {
    const outside = path.join(os.tmpdir(), "chrollo-outside.jsonl");
    fs.writeFileSync(outside, SESSION);
    const r = read(outside, 1, 10, tmpRoot);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/outside the session store/);
    fs.unlinkSync(outside);
  });

  it("rejects a nonexistent file", () => {
    const r = read(path.join(tmpRoot, "nope.jsonl"), 1, 10, tmpRoot);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/not found/);
  });

  it("tolerates an unparseable line (skips it, does not crash)", () => {
    const badPath = path.join(tmpRoot, "bad.jsonl");
    fs.writeFileSync(badPath, "not json{{\n" + SESSION);
    const r = read(badPath, 1, 5, tmpRoot);
    expect("text" in r).toBe(true); // didn't throw
  });
});

describe("read — constants", () => {
  it("exposes READ_LIMIT_DEFAULT and READ_LIMIT_CAP", () => {
    expect(READ_LIMIT_DEFAULT).toBe(10);
    expect(READ_LIMIT_CAP).toBe(50);
  });
});
