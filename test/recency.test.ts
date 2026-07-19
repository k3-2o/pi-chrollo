import { describe, it, expect } from "vitest";
import { recencyMultiplier } from "../src/search";

const DAY_MS = 1000 * 60 * 60 * 24;

// recencyMultiplier uses Date.now() internally, so build dates relative to now.
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

describe("recencyMultiplier", () => {
  it("returns 1.0 for undefined (no timestamp)", () => {
    expect(recencyMultiplier(undefined)).toBe(1.0);
  });

  it("returns 1.0 for future-dated lines (no boost, no penalty)", () => {
    const future = new Date(Date.now() + DAY_MS);
    expect(recencyMultiplier(future)).toBe(1.0);
  });

  it("gives a today memory the max boost (2.0x)", () => {
    expect(recencyMultiplier(daysAgo(0))).toBeCloseTo(2.0, 1);
  });

  it("decays with a ~30-day half-life", () => {
    // At 30 days, the boost term should be ~0.5 → multiplier ~1.5
    expect(recencyMultiplier(daysAgo(30))).toBeCloseTo(1.5, 1);
  });

  it("keeps a week-old memory strongly boosted (~1.85x)", () => {
    // Regression guard: old inverse curve gave ~1.13x at 7 days.
    expect(recencyMultiplier(daysAgo(7))).toBeGreaterThan(1.7);
    expect(recencyMultiplier(daysAgo(7))).toBeLessThan(2.0);
  });

  it("preserves signal at 3 months (~1.13x)", () => {
    const m = recencyMultiplier(daysAgo(90));
    expect(m).toBeGreaterThan(1.05);
    expect(m).toBeLessThan(1.25);
  });

  it("flattens near 1.0 at a year", () => {
    const m = recencyMultiplier(daysAgo(365));
    expect(m).toBeGreaterThan(1.0);
    expect(m).toBeLessThan(1.01);
  });

  it("is monotonically decreasing as age increases", () => {
    const today = recencyMultiplier(daysAgo(0));
    const week = recencyMultiplier(daysAgo(7));
    const month = recencyMultiplier(daysAgo(30));
    const year = recencyMultiplier(daysAgo(365));
    expect(today).toBeGreaterThan(week);
    expect(week).toBeGreaterThan(month);
    expect(month).toBeGreaterThan(year);
  });

  it("never goes below 1.0 (boost only, never penalty)", () => {
    expect(recencyMultiplier(daysAgo(36500))).toBeGreaterThanOrEqual(1.0); // 100 years
  });
});
