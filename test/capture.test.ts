import { describe, it, expect } from "vitest";
import { extractText, formatToolCall } from "../src/capture";

// Real-logic test for capture.ts pure functions (no fs, no rg).

describe("extractText", () => {
  it("returns a trimmed string unchanged (non-empty)", () => {
    expect(extractText("  hello world  ")).toBe("hello world");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(extractText("   ")).toBe("");
    expect(extractText("")).toBe("");
  });

  it("joins multiple text blocks with newlines, trimmed", () => {
    const content = [
      { type: "text", text: "first paragraph" },
      { type: "text", text: "  second paragraph  " },
    ];
    expect(extractText(content as any)).toBe("first paragraph\nsecond paragraph");
  });

  it("skips non-text blocks and empty text blocks", () => {
    const content = [
      { type: "toolCall", name: "bash" },
      { type: "text", text: "   " },
      { type: "text", text: "kept" },
    ];
    expect(extractText(content as any)).toBe("kept");
  });

  it("returns empty when no text blocks are present", () => {
    const content = [{ type: "toolCall" }, { type: "toolResult" }];
    expect(extractText(content as any)).toBe("");
  });

  it("handles unknown input shapes defensively", () => {
    expect(extractText(undefined as any)).toBe("");
    expect(extractText(null as any)).toBe("");
    expect(extractText(42 as any)).toBe("");
  });
});

describe("formatToolCall", () => {
  it("wraps bash commands as <tool>$ ...</tool>", () => {
    const out: string[] = [];
    formatToolCall("bash", { command: "ls -la" }, out);
    expect(out).toEqual(["<tool>$ ls -la</tool>"]);
  });

  it("omits bash entry when command is missing or non-string", () => {
    const out: string[] = [];
    formatToolCall("bash", { command: 123 }, out);
    expect(out).toEqual([]);
  });

  it("formats read/grep/find/ls with their first string arg", () => {
    const out: string[] = [];
    formatToolCall("read", { path: "/tmp/x.ts", offset: 5 }, out);
    formatToolCall("grep", { pattern: "foo" }, out);
    expect(out).toEqual(["<tool>read /tmp/x.ts</tool>", "<tool>grep foo</tool>"]);
  });

  it("formats edit/write with path or file", () => {
    const o1: string[] = [];
    formatToolCall("edit", { path: "src/a.ts" }, o1);
    expect(o1).toEqual(["<tool>edit src/a.ts</tool>"]);

    const o2: string[] = [];
    formatToolCall("write", { file: "out.txt" }, o2);
    expect(o2).toEqual(["<tool>write out.txt</tool>"]);

    const o3: string[] = [];
    formatToolCall("edit", {}, o3);
    expect(o3).toEqual(["<tool>edit</tool>"]);
  });

  it("falls back to <name> + first string arg for unknown tools", () => {
    const out: string[] = [];
    formatToolCall("omnisearch_gateway", { query: "delta rust" }, out);
    expect(out).toEqual(["<tool>omnisearch_gateway delta rust</tool>"]);
  });
});
