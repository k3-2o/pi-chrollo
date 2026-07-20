import { describe, it, expect } from "vitest";
import { formatSearchLine, formatReadMessage, formatCompactionGap } from "../src/format";
import type { MessageRecord, CompactionRecord } from "../src/normalize";

function makeMsg(opts: Partial<MessageRecord>): MessageRecord {
  return {
    kind: "message",
    source: "pi",
    role: "user",
    text: "",
    toolCalls: [],
    timestamp: 0,
    lineKey: "/p/s.jsonl:1",
    ...opts,
  };
}

describe("formatSearchLine", () => {
  it("renders path:line | role: preview", () => {
    const r = makeMsg({
      lineKey: "/p/s.jsonl:42",
      role: "user",
      text: "fix the docker compose bug",
    });
    expect(formatSearchLine(r)).toBe("/p/s.jsonl:42 | user: fix the docker compose bug");
  });

  it("collapses internal whitespace in the preview", () => {
    const r = makeMsg({ text: "line one\n\n  line two   end" });
    expect(formatSearchLine(r)).toMatch(/line one line two end/);
  });

  it("truncates a long preview with an ellipsis", () => {
    const r = makeMsg({ text: "x".repeat(300) });
    const out = formatSearchLine(r);
    // The preview text (after 'role: ') is capped at MAX_PREVIEW_LEN (200 incl ellipsis).
    const afterRole = out.split(": ").slice(1).join(": ");
    expect(afterRole.length).toBeLessThanOrEqual(200);
    expect(afterRole).toMatch(/…$/);
  });

  it("preserves an empty preview cleanly", () => {
    const r = makeMsg({ text: "" });
    expect(formatSearchLine(r)).toMatch(/user: $/);
  });
});

describe("formatReadMessage", () => {
  it("renders a user text block with a clock prefix", () => {
    const r = makeMsg({
      role: "user",
      text: "hello world",
      timestamp: new Date("2026-07-01T10:00:00.000Z").getTime(),
    });
    const out = formatReadMessage(r);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\[\d{2}:\d{2}\] user: hello world$/);
  });

  it("renders an assistant text block", () => {
    const r = makeMsg({
      role: "assistant",
      text: "let me check that",
      timestamp: new Date("2026-07-01T10:00:00.000Z").getTime(),
    });
    expect(formatReadMessage(r)[0]).toMatch(/^\[\d{2}:\d{2}\] assistant: let me check that$/);
  });

  it("omits the clock prefix when timestamp is unknown (0)", () => {
    const r = makeMsg({ role: "user", text: "no time", timestamp: 0 });
    expect(formatReadMessage(r)[0]).toBe("user: no time");
  });

  it("renders toolCalls as compact > name(args) lines", () => {
    const r = makeMsg({
      role: "assistant",
      text: "reading the file",
      toolCalls: [{ name: "read", args: { path: "foo.ts", limit: 10 } }],
      timestamp: new Date("2026-07-01T10:00:00.000Z").getTime(),
    });
    const out = formatReadMessage(r);
    expect(out[0]).toMatch(/^\[\d{2}:\d{2}\] assistant: reading the file$/);
    expect(out[1]).toMatch(/^> read\(/);
    expect(out[1]).toContain("foo.ts");
  });

  it("truncates long toolCall args with an ellipsis (inside the parens)", () => {
    const r = makeMsg({
      role: "assistant",
      toolCalls: [{ name: "bash", args: "x".repeat(100) }],
    });
    const line = formatReadMessage(r)[0];
    // The ellipsis sits immediately before the closing paren: '> bash(xxx…)'
    expect(line).toMatch(/^> bash\(.*…\)$/);
    expect(line.length).toBeLessThan(70); // well under the raw 100-char arg
  });

  it("handles toolCalls with undefined/null args", () => {
    expect(formatReadMessage(makeMsg({ toolCalls: [{ name: "ls", args: undefined }] }))[0]).toBe(
      "> ls()",
    );
    expect(formatReadMessage(makeMsg({ toolCalls: [{ name: "ls", args: null }] }))[0]).toBe(
      "> ls()",
    );
  });

  it("handles a non-serializable arg safely", () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(formatReadMessage(makeMsg({ toolCalls: [{ name: "x", args: cyclic }] }))[0]).toBe(
      "> x(?)",
    );
  });

  it("returns only text line when there are no toolCalls", () => {
    const r = makeMsg({ text: "just text" });
    expect(formatReadMessage(r)).toEqual(["user: just text"]);
  });

  it("returns only toolCall lines when text is empty", () => {
    const r = makeMsg({ text: "", toolCalls: [{ name: "ls", args: undefined }] });
    expect(formatReadMessage(r)).toEqual(["> ls()"]);
  });
});

describe("formatCompactionGap", () => {
  it("renders a gap marker", () => {
    const rec: CompactionRecord = {
      kind: "compaction",
      source: "pi",
      timestamp: 0,
      lineKey: "/p/s.jsonl:50",
    };
    const out = formatCompactionGap(rec);
    expect(out).toMatch(/^\[\.\.\.context compacted/);
  });
});
