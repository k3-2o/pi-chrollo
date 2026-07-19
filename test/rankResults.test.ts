import { describe, it, expect } from "vitest";
import { rankResults } from "../src/search";
import type { CompactResult } from "../src/search";

const DAY_MS = 1000 * 60 * 60 * 24;
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function mk(overrides: Partial<CompactResult> & { matchedTerms: string[] }): CompactResult {
  return {
    text: overrides.text ?? "line",
    source: overrides.source ?? "session.md",
    sourcePath: overrides.sourcePath ?? "/memories/session.md",
    line: overrides.line ?? 1,
    matchedTerms: overrides.matchedTerms,
    lineDate: overrides.lineDate,
  };
}

describe("rankResults", () => {
  it("dedups by file:line (keeps first occurrence)", () => {
    const dupes: CompactResult[] = [
      mk({ sourcePath: "/a.md", line: 5, matchedTerms: ["x"] }),
      mk({ sourcePath: "/a.md", line: 5, matchedTerms: ["x"] }),
      mk({ sourcePath: "/b.md", line: 1, matchedTerms: ["x"] }),
    ];
    const out = rankResults(dupes);
    expect(out).toHaveLength(2);
  });

  it("counts DISTINCT matched terms, not repeats (AD-14)", () => {
    // A line where the same term matched 3x must NOT outrank a line with 2
    // distinct terms.
    const same = mk({
      sourcePath: "/same.md",
      line: 1,
      matchedTerms: ["memory", "memory", "memory"],
    });
    const distinct = mk({ sourcePath: "/distinct.md", line: 1, matchedTerms: ["alpha", "beta"] });
    const out = rankResults([same, distinct]);
    expect(out[0]).toBe(distinct); // 2 distinct > 1 distinct (despite 3 raw)
  });

  it("ranks more distinct terms above fewer", () => {
    const three = mk({ sourcePath: "/three.md", line: 1, matchedTerms: ["a", "b", "c"] });
    const two = mk({ sourcePath: "/two.md", line: 1, matchedTerms: ["a", "b"] });
    const out = rankResults([two, three]);
    expect(out[0]).toBe(three);
  });

  it("breaks ties by recency (newer first)", () => {
    const old = mk({ sourcePath: "/old.md", line: 1, matchedTerms: ["a"], lineDate: daysAgo(100) });
    const recent = mk({
      sourcePath: "/recent.md",
      line: 1,
      matchedTerms: ["a"],
      lineDate: daysAgo(1),
    });
    const out = rankResults([old, recent]);
    expect(out[0]).toBe(recent);
  });

  it("caps at MAX_RESULTS (20)", () => {
    const many: CompactResult[] = Array.from({ length: 50 }, (_, i) =>
      mk({ sourcePath: `/f${i}.md`, line: i + 1, matchedTerms: ["x"] }),
    );
    expect(rankResults(many)).toHaveLength(20);
  });

  it("applies a per-file diversity cap (AD-9): max 3 from any one file", () => {
    // 5 results from one file, 1 each from 4 others. After the cap, the one
    // file contributes 3 and the 4 others contribute 1 each = 7 total.
    const same: CompactResult[] = Array.from({ length: 5 }, (_, i) =>
      mk({ sourcePath: "/marathon.md", line: i + 1, matchedTerms: ["auth", "token"] }),
    );
    const others: CompactResult[] = ["a", "b", "c", "d"].map((s, i) =>
      mk({ sourcePath: `/${s}.md`, line: 1, matchedTerms: ["auth"] }),
    );
    const out = rankResults([...same, ...others]);
    const fromMarathon = out.filter((r) => r.sourcePath === "/marathon.md");
    expect(fromMarathon.length).toBeLessThanOrEqual(3);
    expect(out.length).toBe(7); // 3 + 4
  });

  it("per-file cap does not drop below-highest matches unnecessarily (still returns up to MAX)", () => {
    // 30 distinct files, one match each -> 30 results, but capped at MAX_RESULTS=20
    const many: CompactResult[] = Array.from({ length: 30 }, (_, i) =>
      mk({ sourcePath: `/f${i}.md`, line: 1, matchedTerms: ["x"] }),
    );
    expect(rankResults(many)).toHaveLength(20);
  });

  it("returns [] for empty input", () => {
    expect(rankResults([])).toEqual([]);
  });
});
