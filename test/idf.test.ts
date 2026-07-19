import { describe, it, expect } from "vitest";
import { rankResults, buildIdfWeights, type RankContext } from "../src/search";
import type { CompactResult } from "../src/search";

// Phase 10C: IDF-weighted ranking — rare-word matches count more.

function mk(path: string, line: number, matchedTerms: string[]): CompactResult {
  return {
    text: "line",
    source: path,
    sourcePath: path,
    line,
    matchedTerms,
    lineDate: undefined, // no recency — isolate the IDF effect
  };
}

describe("buildIdfWeights", () => {
  it("gives rare terms higher weight than common terms", () => {
    const freq = new Map([
      ["k3s", 2],
      ["config", 250],
    ]);
    const w = buildIdfWeights(["k3s", "config"], freq, 288);
    expect(w.get("k3s")!).toBeGreaterThan(w.get("config")!);
  });

  it("a term in zero files gets max weight", () => {
    const w = buildIdfWeights(["unheard"], new Map(), 288);
    expect(w.get("unheard")).toBeCloseTo(Math.log(1 + 288), 1);
  });

  it("a term in ALL files gets low weight relative to rare terms", () => {
    const freq = new Map([
      ["common", 288],
      ["rare", 2],
    ]);
    const w = buildIdfWeights(["common", "rare"], freq, 288);
    // common gets ~0.69, rare gets ~4.7 — common is much lower
    expect(w.get("common")!).toBeLessThan(w.get("rare")! / 3);
  });

  it("totalFiles=0 doesn't divide by zero", () => {
    const w = buildIdfWeights(["anything"], new Map(), 0);
    // log(1 + 0/1) = log(1) = 0 — safe, returns 0 weight
    expect(w.get("anything")).toBe(0);
  });

  it("includes stem weights (deployment -> deploy shares the weight)", () => {
    const freq = new Map([["deployment", 5]]);
    const w = buildIdfWeights(["deployment"], freq, 288);
    const s = w.get("deploy");
    expect(s).toBeDefined();
    expect(s).toBeCloseTo(w.get("deployment")!, 5);
  });
});

describe("rankResults with IDF weighting", () => {
  it("a rare-term match outranks a common-term match at equal distinct count", () => {
    const freq = new Map([
      ["k3s", 2],
      ["config", 250],
    ]);
    const idf = buildIdfWeights(["k3s", "config"], freq, 288);
    const ctx: RankContext = { idfWeights: idf };

    const rareMatch = mk("/rare.md", 1, ["k3s"]);
    const commonMatch = mk("/common.md", 1, ["config"]);

    const out = rankResults([commonMatch, rareMatch], ctx);
    expect(out[0]).toBe(rareMatch); // k3s (rare) ranks above config (common)
  });

  it("without IDF weights: falls back to distinct-term counting (backwards compat)", () => {
    const a = mk("/a.md", 1, ["x"]);
    const b = mk("/b.md", 1, ["x"]);
    const out = rankResults([a, b]);
    expect(out).toHaveLength(2); // no crash, both included
  });

  it("existing per-file cap behavior preserved with IDF", () => {
    const freq = new Map([["term", 1]]);
    const idf = buildIdfWeights(["term"], freq, 288);
    const ctx: RankContext = { idfWeights: idf };
    const many = Array.from({ length: 50 }, (_, i) => mk(`/f${i}.md`, 1, ["term"]));
    expect(rankResults(many, ctx)).toHaveLength(20); // MAX_RESULTS
  });

  it("two rare-term match beats one rare-term match (IDF sums)", () => {
    const freq = new Map([
      ["alpha", 3],
      ["beta", 3],
    ]);
    const idf = buildIdfWeights(["alpha", "beta"], freq, 288);
    const ctx: RankContext = { idfWeights: idf };

    const twoTerms = mk("/two.md", 1, ["alpha", "beta"]);
    const oneTerm = mk("/one.md", 1, ["alpha"]);

    const out = rankResults([oneTerm, twoTerms], ctx);
    expect(out[0]).toBe(twoTerms);
  });
});
