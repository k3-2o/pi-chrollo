import { describe, it, expect } from "vitest";
import {
  dedupKey,
  topicChanged,
  filterInjected,
  recordInjected,
  isTrivialPrompt,
  sameTerms,
} from "../src/inject";
import type { CompactResult } from "../src/search";

// Phase 6: injection dedup (AD-10) — pure helpers.

function mk(path: string, line: number): CompactResult {
  return {
    text: "x",
    source: path,
    sourcePath: path,
    line,
    matchedTerms: ["t"],
  };
}

describe("dedupKey", () => {
  it("builds a stable sourcePath:line key", () => {
    expect(dedupKey(mk("/a/b.md", 42))).toBe("/a/b.md:42");
  });
});

describe("sameTerms (Phase 10A Gate 2)", () => {
  it("true for identical sets regardless of insertion order", () => {
    expect(sameTerms(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
  });

  it("false when sizes differ (new term added)", () => {
    expect(sameTerms(new Set(["a", "b"]), new Set(["a", "b", "c"]))).toBe(false);
  });

  it("false when any term differs (a swap)", () => {
    expect(sameTerms(new Set(["a", "b"]), new Set(["a", "c"]))).toBe(false);
  });

  it("true for two empty sets", () => {
    expect(sameTerms(new Set(), new Set())).toBe(true);
  });
});

describe("isTrivialPrompt (Phase 10A gate)", () => {
  it("flags pure acknowledgements", () => {
    expect(isTrivialPrompt("yes")).toBe(true);
    expect(isTrivialPrompt("ok")).toBe(true);
    expect(isTrivialPrompt("okay cool")).toBe(true);
    expect(isTrivialPrompt("gotcha")).toBe(true);
    expect(isTrivialPrompt("nope")).toBe(true);
  });

  it("flags greetings", () => {
    expect(isTrivialPrompt("hi")).toBe(true);
    expect(isTrivialPrompt("hello hey")).toBe(true);
    expect(isTrivialPrompt("yo")).toBe(true);
  });

  it("flags thanks", () => {
    expect(isTrivialPrompt("thanks")).toBe(true);
    expect(isTrivialPrompt("thank you")).toBe(true);
    expect(isTrivialPrompt("thx")).toBe(true);
  });

  it("flags continuations", () => {
    expect(isTrivialPrompt("continue")).toBe(true);
    expect(isTrivialPrompt("go ahead")).toBe(true);
    expect(isTrivialPrompt("keep going")).toBe(true);
    expect(isTrivialPrompt("next")).toBe(true);
  });

  it("passes prompts with real searchable content", () => {
    expect(isTrivialPrompt("how do I configure kanagawa in obsidian")).toBe(false);
    expect(isTrivialPrompt("fix the search bug")).toBe(false);
    expect(isTrivialPrompt("yes that worked but now I need to set up k3s")).toBe(false);
    expect(isTrivialPrompt("what did we decide about postgres")).toBe(false);
  });

  it("passes even a single distinctive word", () => {
    expect(isTrivialPrompt("chrollo")).toBe(false);
    expect(isTrivialPrompt("postgres")).toBe(false);
    expect(isTrivialPrompt("deployment")).toBe(false);
  });

  it("handles punctuation (strips it before checking)", () => {
    expect(isTrivialPrompt("ok, thanks!")).toBe(true);
    expect(isTrivialPrompt("yes.")).toBe(true);
  });

  it("treats empty/whitespace as trivial", () => {
    expect(isTrivialPrompt("")).toBe(true);
    expect(isTrivialPrompt("   ")).toBe(true);
  });
});

describe("topicChanged", () => {
  it("is true when the two term-sets share NO term", () => {
    expect(topicChanged(new Set(["auth", "token"]), new Set(["search", "index"]))).toBe(true);
  });

  it("is false when the sets share at least one term (same topic)", () => {
    expect(topicChanged(new Set(["auth", "token"]), new Set(["token", "refresh"]))).toBe(false);
  });

  it("is false when the new set is identical", () => {
    expect(topicChanged(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(false);
  });

  it("is false when EITHER set is empty (no prior topic, or nothing to say)", () => {
    expect(topicChanged(new Set(), new Set(["x"]))).toBe(false);
    expect(topicChanged(new Set(["x"]), new Set())).toBe(false);
    expect(topicChanged(new Set(), new Set())).toBe(false);
  });

  it("is true only on a full break — any single overlap keeps the topic", () => {
    expect(topicChanged(new Set(["a", "b", "c"]), new Set(["c", "d", "e"]))).toBe(false);
    expect(topicChanged(new Set(["a", "b", "c"]), new Set(["d", "e", "f"]))).toBe(true);
  });
});

describe("filterInjected + recordInjected", () => {
  it("filterInjected drops results whose key is already in the set", () => {
    const injected = new Set<string>(["/a.md:1", "/b.md:5"]);
    const results = [mk("/a.md", 1), mk("/a.md", 2), mk("/b.md", 5), mk("/c.md", 1)];
    const fresh = filterInjected(results, injected);
    expect(fresh.map((r) => r.sourcePath + ":" + r.line)).toEqual(["/a.md:2", "/c.md:1"]);
  });

  it("filterInjected does not mutate its inputs", () => {
    const injected = new Set<string>(["/a.md:1"]);
    const results = [mk("/a.md", 1), mk("/b.md", 2)];
    const snapshot = new Set(injected);
    filterInjected(results, injected);
    expect(injected).toEqual(snapshot); // unchanged
  });

  it("returns everything when nothing has been injected yet", () => {
    const results = [mk("/a.md", 1), mk("/b.md", 2)];
    expect(filterInjected(results, new Set())).toEqual(results);
  });

  it("recordInjected adds keys to the set (mutates)", () => {
    const injected = new Set<string>();
    const results = [mk("/a.md", 1), mk("/b.md", 2)];
    recordInjected(results, injected);
    expect(injected.has("/a.md:1")).toBe(true);
    expect(injected.has("/b.md:2")).toBe(true);
    expect(injected.size).toBe(2);
  });

  it("round-trip: after recordInjected, a repeat call to filterInjected yields nothing", () => {
    const injected = new Set<string>();
    const results = [mk("/a.md", 1), mk("/b.md", 2)];
    recordInjected(results, injected);
    expect(filterInjected(results, injected)).toEqual([]);
  });
});
