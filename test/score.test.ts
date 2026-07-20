import { describe, it, expect } from "vitest";
import { tfSaturation } from "../src/score";

describe("tfSaturation — term-frequency saturation", () => {
  it("scores a 5-hit line less than 5× a 1-hit line", () => {
    const one = tfSaturation(1, 10, 10);
    const five = tfSaturation(5, 10, 10);
    expect(five).toBeGreaterThan(one); // more hits still ranks higher
    expect(five / one).toBeLessThan(5); // but well under linear scaling
  });

  it("returns 0 for a term that does not appear in the line", () => {
    expect(tfSaturation(0, 10, 10)).toBe(0);
  });
});

describe("tfSaturation — length normalization", () => {
  it("ranks a hit in a short line above a hit in a long line", () => {
    const shortLine = tfSaturation(1, 5, 10);
    const longLine = tfSaturation(1, 50, 10);
    expect(shortLine).toBeGreaterThan(longLine);
  });

  it("does not divide by zero when avgLen is 0", () => {
    expect(() => tfSaturation(1, 10, 0)).not.toThrow();
    expect(Number.isFinite(tfSaturation(1, 10, 0))).toBe(true);
  });
});

describe("tfSaturation — regression (hand-verified constants)", () => {
  // No IDF term anymore — the score is purely the saturated, length-normalized
  // term frequency. tf=2, lineLen=10, avgLen=10: norm=1.0, tf = 5/3.5 ≈ 1.42857
  it("matches the known score for a fixed input", () => {
    expect(tfSaturation(2, 10, 10)).toBeCloseTo(1.428571, 4);
  });
});
