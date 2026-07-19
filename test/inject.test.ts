import { describe, it, expect } from "vitest";
import { dedupKey, topicChanged, filterInjected, recordInjected } from "../src/inject";
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
