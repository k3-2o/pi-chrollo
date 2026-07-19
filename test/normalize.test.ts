import { describe, it, expect } from "vitest";
import { parseLine, extractSessionCwd, type MessageRecord } from "../src/normalize";

const PATH = "/home/k2/.pi/agent/sessions/--home-k2-proj--/2026-07-01T10-00-00-000Z_abc.jsonl";

// Helper: parse at a given line number, assert it's a message record.
function msg(path: string, line: number, raw: string): MessageRecord | null {
  const r = parseLine(path, line, raw);
  if (r === null || r.kind !== "message") return null;
  return r;
}

describe("parseLine — user message", () => {
  it("extracts role, text, timestamp, and lineKey", () => {
    const raw =
      '{"type":"message","id":"u1","parentId":null,' +
      '"timestamp":"2026-07-01T10:00:01.000Z",' +
      '"message":{"role":"user","content":[{"type":"text","text":"fix the docker bug"}]}}';
    const r = msg(PATH, 7, raw);
    expect(r).not.toBeNull();
    expect(r!.role).toBe("user");
    expect(r!.text).toBe("fix the docker bug");
    expect(r!.toolCalls).toEqual([]);
    expect(r!.source).toBe("pi");
    expect(r!.timestamp).toBe(Date.parse("2026-07-01T10:00:01.000Z"));
    expect(r!.lineKey).toBe(`${PATH}:7`);
  });
});

describe("parseLine — assistant message", () => {
  const raw =
    '{"type":"message","id":"a1","parentId":"u1",' +
    '"timestamp":"2026-07-01T10:00:02.000Z",' +
    '"message":{"role":"assistant","content":[' +
    '{"type":"thinking","thinking":"internal reasoning"},' +
    '{"type":"text","text":"let me check the config"},' +
    '{"type":"toolCall","name":"read","arguments":{"path":"foo.ts","limit":10}}' +
    "]}}";

  it("keeps text blocks, skips thinking", () => {
    const r = msg(PATH, 8, raw);
    expect(r!.role).toBe("assistant");
    expect(r!.text).toBe("let me check the config");
  });

  it("keeps toolCall name + args for rendering", () => {
    const r = msg(PATH, 8, raw);
    expect(r!.toolCalls).toHaveLength(1);
    expect(r!.toolCalls[0].name).toBe("read");
    expect(r!.toolCalls[0].args).toEqual({ path: "foo.ts", limit: 10 });
  });

  it("joins multiple text blocks with newline", () => {
    const multi =
      '{"type":"message","timestamp":"2026-07-01T10:00:03.000Z",' +
      '"message":{"role":"assistant","content":[' +
      '{"type":"text","text":"first"},' +
      '{"type":"text","text":"second"}' +
      "]}}";
    expect(msg(PATH, 1, multi)!.text).toBe("first\nsecond");
  });
});

describe("parseLine — dropped line types", () => {
  it("drops toolResult (tool outputs)", () => {
    const raw =
      '{"type":"message","timestamp":"2026-07-01T10:00:03.000Z",' +
      '"message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":"file contents"}}';
    const r = parseLine(PATH, 9, raw);
    expect(r?.kind).toBe("skip");
  });

  it("drops the session header (metadata)", () => {
    const raw =
      '{"type":"session","version":3,"id":"abc",' +
      '"timestamp":"2026-07-01T10:00:00.000Z","cwd":"/home/k2/proj"}';
    expect(parseLine(PATH, 1, raw)?.kind).toBe("skip");
  });

  it("drops model_change and thinking_level_change", () => {
    const mc =
      '{"type":"model_change","id":"x","parentId":null,' +
      '"timestamp":"2026-07-01T10:00:00.500Z","provider":"p","modelId":"m"}';
    expect(parseLine(PATH, 2, mc)?.kind).toBe("skip");
    const tlc =
      '{"type":"thinking_level_change","id":"y","parentId":"x",' +
      '"timestamp":"2026-07-01T10:00:00.501Z","thinkingLevel":"off"}';
    expect(parseLine(PATH, 3, tlc)?.kind).toBe("skip");
  });

  it("drops custom_message (incl. any future chrollo self-injection)", () => {
    const raw =
      '{"type":"custom_message","customType":"chrollo","content":"injected noise",' +
      '"timestamp":"2026-07-01T10:00:00.000Z"}';
    expect(parseLine(PATH, 4, raw)?.kind).toBe("skip");
  });

  it("drops an unknown message role", () => {
    const raw =
      '{"type":"message","timestamp":"2026-07-01T10:00:00.000Z",' +
      '"message":{"role":"system","content":[{"type":"text","text":"hi"}]}}';
    expect(parseLine(PATH, 5, raw)?.kind).toBe("skip");
  });
});

describe("parseLine — compaction boundary", () => {
  it("surfaces compaction as its own kind (read annotates, search ignores)", () => {
    const raw =
      '{"type":"compaction","id":"comp1","parentId":"p",' +
      '"timestamp":"2026-07-15T04:00:21.968Z","summary":"compacted context"}';
    const r = parseLine(PATH, 50, raw);
    expect(r?.kind).toBe("compaction");
    if (r?.kind === "compaction") {
      expect(r.timestamp).toBe(Date.parse("2026-07-15T04:00:21.968Z"));
      expect(r.lineKey).toBe(`${PATH}:50`);
    }
  });
});

describe("parseLine — robustness", () => {
  it("returns null (not throw) on unparseable JSON", () => {
    expect(parseLine(PATH, 99, "not json{{")).toBeNull();
    expect(parseLine(PATH, 99, "")).toBeNull();
  });

  it("returns skip on a non-object JSON value", () => {
    expect(parseLine(PATH, 1, '"just a string"')?.kind).toBe("skip");
    expect(parseLine(PATH, 1, "null")?.kind).toBe("skip");
    expect(parseLine(PATH, 1, "42")?.kind).toBe("skip");
  });

  it("returns skip on a message with no message field", () => {
    expect(parseLine(PATH, 1, '{"type":"message"}')?.kind).toBe("skip");
  });

  it("handles a message with empty content array", () => {
    const raw =
      '{"type":"message","timestamp":"2026-07-01T10:00:00.000Z",' +
      '"message":{"role":"assistant","content":[]}}';
    const r = msg(PATH, 1, raw);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("");
    expect(r!.toolCalls).toEqual([]);
  });

  it("handles a message with missing timestamp (epoch 0 fallback)", () => {
    const raw =
      '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';
    const r = msg(PATH, 1, raw);
    expect(r!.timestamp).toBe(0);
  });

  it("ignores content blocks that are not objects", () => {
    const raw =
      '{"type":"message","timestamp":"2026-07-01T10:00:00.000Z",' +
      '"message":{"role":"user","content":["string-block", null, 42, {"type":"text","text":"keep"}]}}';
    expect(msg(PATH, 1, raw)!.text).toBe("keep");
  });
});

describe("parseLine — path dispatch (adapter seam)", () => {
  it("parses Pi paths via the Pi adapter", () => {
    const raw =
      '{"type":"message","timestamp":"2026-07-01T10:00:00.000Z",' +
      '"message":{"role":"user","content":[{"type":"text","text":"hello"}]}}';
    expect(parseLine(PATH, 1, raw)?.kind).toBe("message");
  });

  it("defaults unknown paths to the Pi shape (v1)", () => {
    const raw =
      '{"type":"message","timestamp":"2026-07-01T10:00:00.000Z",' +
      '"message":{"role":"user","content":[{"type":"text","text":"hello"}]}}';
    // A non-Pi path still parses with the default adapter for now.
    expect(parseLine("/some/other/path.jsonl", 1, raw)?.kind).toBe("message");
  });
});

describe("extractSessionCwd", () => {
  it("returns cwd from a session header line", () => {
    const raw =
      '{"type":"session","version":3,"id":"abc",' +
      '"timestamp":"2026-07-01T10:00:00.000Z","cwd":"/home/k2/proj"}';
    expect(extractSessionCwd(raw)).toBe("/home/k2/proj");
  });

  it("returns undefined for a non-session line", () => {
    const raw =
      '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';
    expect(extractSessionCwd(raw)).toBeUndefined();
  });

  it("returns undefined on unparseable input", () => {
    expect(extractSessionCwd("garbage")).toBeUndefined();
    expect(extractSessionCwd("")).toBeUndefined();
  });

  it("returns undefined when cwd field is missing", () => {
    expect(extractSessionCwd('{"type":"session"}')).toBeUndefined();
  });
});
