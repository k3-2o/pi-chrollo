import { describe, it, expect } from "vitest";
import { bm25 } from "../src/bm25";

describe("bm25 — saturation (term-frequency)", () => {
  it("scores a 5-hit line less than 5× a 1-hit line", () => {
    const one = bm25(1, 10, 10, 5, 100);
    const five = bm25(5, 10, 10, 5, 100);
    expect(five).toBeGreaterThan(one); // more hits still ranks higher
    expect(five / one).toBeLessThan(5); // but well under linear scaling
  });

  it("returns 0 for a term that does not appear in the line", () => {
    expect(bm25(0, 10, 10, 5, 100)).toBe(0);
  });
});

describe("bm25 — length normalization", () => {
  it("ranks a hit in a short line above a hit in a long line", () => {
    const shortLine = bm25(1, 5, 10, 5, 100);
    const longLine = bm25(1, 50, 10, 5, 100);
    expect(shortLine).toBeGreaterThan(longLine);
  });

  it("does not divide by zero when avgLen is 0", () => {
    expect(() => bm25(1, 10, 0, 5, 100)).not.toThrow();
    expect(Number.isFinite(bm25(1, 10, 0, 5, 100))).toBe(true);
  });
});

describe("bm25 — IDF weighting (rarity)", () => {
  it("scores a rare term higher than a common term at equal tf/length", () => {
    const rare = bm25(1, 10, 10, 1, 100); // appears in 1/100 docs
    const common = bm25(1, 10, 10, 99, 100); // appears in 99/100 docs
    expect(rare).toBeGreaterThan(common);
  });

  it("produces a non-negative IDF even when a term is in every document", () => {
    // BM25's +1-inside-log variant guarantees idf ≥ 0 (unlike raw ln(N/n)).
    const everywhere = bm25(1, 10, 10, 100, 100);
    expect(everywhere).toBeGreaterThanOrEqual(0);
  });
});

describe("bm25 — regression (hand-verified constants)", () => {
  // Locks the formula and constants. tf=2, lineLen=10, avgLen=10, df=5, N=100.
  // idf = ln(1 + 95.5/5.5) ≈ 2.9104 ; tf-norm = 5/3.5 ≈ 1.4286 ; product ≈ 4.1577
  it("matches the known score for a fixed input", () => {
    expect(bm25(2, 10, 10, 5, 100)).toBeCloseTo(4.157675, 4);
  });
});
