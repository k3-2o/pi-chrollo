import { describe, it, expect } from "vitest";

// Sanity test: proves the vitest harness runs and basic assertions work.
// Real tests live alongside the modules they cover (test/*.test.ts).

describe("sanity", () => {
  it("runs the test harness", () => {
    expect(1 + 1).toBe(2);
  });

  it("has ripgrep available (integration tests depend on it)", () => {
    // Not a real unit test — a documented precondition. If rg is missing,
    // the search integration tests will skip/fail; this surfaces it early.
    const { spawnSync } = require("node:child_process");
    const res = spawnSync("rg", ["--version"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ripgrep/);
  });
});
