import { describe, it, expect } from "vitest";
import {
  recencyMultiplier,
  cwdBoost,
  scoreLine,
  rankCandidates,
  diversityCap,
  filePathOf,
} from "../src/rank";
import type { MessageRecord } from "../src/normalize";

const DAY_MS = 1000 * 60 * 60 * 24;

function makeRecord(
  text: string,
  opts: { ts?: number; path?: string; line?: number } = {},
): MessageRecord {
  return {
    kind: "message",
    source: "pi",
    role: "user",
    text,
    toolCalls: [],
    timestamp: opts.ts ?? 0,
    lineKey: `${opts.path ?? "/p/s.jsonl"}:${opts.line ?? 1}`,
  };
}

describe("recencyMultiplier", () => {
  it("peaks near 2.0 for a timestamp of today", () => {
    expect(recencyMultiplier(Date.now())).toBeCloseTo(2.0, 1);
  });

  it("decays to 1.5 at one half-life (30 days)", () => {
    expect(recencyMultiplier(Date.now() - 30 * DAY_MS)).toBeCloseTo(1.5, 1);
  });

  it("returns 1.0 for an unknown (0) timestamp", () => {
    expect(recencyMultiplier(0)).toBe(1.0);
  });

  it("returns 1.0 for a future timestamp (no penalty, no boost)", () => {
    expect(recencyMultiplier(Date.now() + DAY_MS)).toBe(1.0);
  });

  it("respects a custom half-life", () => {
    expect(recencyMultiplier(Date.now() - 7 * DAY_MS, 7)).toBeCloseTo(1.5, 1);
  });
});

describe("cwdBoost", () => {
  it("boosts when line cwd matches session cwd", () => {
    expect(cwdBoost("/proj", "/proj")).toBeGreaterThan(1.0);
  });

  it("is neutral when cwds differ", () => {
    expect(cwdBoost("/proj", "/other")).toBe(1.0);
  });

  it("is neutral when either cwd is missing", () => {
    expect(cwdBoost(undefined, "/proj")).toBe(1.0);
    expect(cwdBoost("/proj", undefined)).toBe(1.0);
    expect(cwdBoost(undefined, undefined)).toBe(1.0);
  });
});

describe("scoreLine", () => {
  it("scores > 0 when the line contains the query term", () => {
    const rec = makeRecord("docker compose port mapping");
    expect(scoreLine(rec, ["docker"], 10)).toBeGreaterThan(0);
  });

  it("scores 0 when the line contains none of the query terms", () => {
    const rec = makeRecord("docker compose port mapping");
    expect(scoreLine(rec, ["kubernetes"], 10)).toBe(0);
  });

  // NOTE: the "rare term > common term" test is intentionally GONE — that
  // behavior required the global corpus dictionary (the 13s-freeze bug,
  // SPEC §3.3) and is permanently removed. All query terms now weight equally.

  it("is stem-aware: query 'deployment' scores a line with 'deploy'", () => {
    const rec = makeRecord("deploy the cluster");
    // query term "deployment" -> groupWithStem -> ["deployment","deploy"]
    // line token "deploy" matches the stem form -> tf > 0 -> score > 0
    expect(scoreLine(rec, ["deployment"], 10)).toBeGreaterThan(0);
  });

  it("scores multiple query-term hits higher than a single hit", () => {
    const rec = makeRecord("docker compose port");
    expect(scoreLine(rec, ["docker", "compose"], 10)).toBeGreaterThan(
      scoreLine(rec, ["docker"], 10),
    );
  });

  it("boosts a recent line above an old line (recency effect)", () => {
    const recent = makeRecord("docker bug", { ts: Date.now() });
    const old = makeRecord("docker bug", { ts: Date.now() - 365 * DAY_MS });
    expect(scoreLine(recent, ["docker"], 10)).toBeGreaterThan(scoreLine(old, ["docker"], 10));
  });

  it("boosts a same-cwd line above a cross-cwd line", () => {
    const rec = makeRecord("docker bug");
    const sameCwd = scoreLine(rec, ["docker"], 10, "/proj", "/proj");
    const crossCwd = scoreLine(rec, ["docker"], 10, "/other", "/proj");
    expect(sameCwd).toBeGreaterThan(crossCwd);
  });

  it("regression: known deterministic score (ts=0, no cwd, avgLen=10)", () => {
    // No IDF now — score == sum of tfSaturation across matched terms.
    // lineLen for "docker compose port mapping" = 4 tokens.
    // tf=1, avgLen=10: norm = 0.25 + 0.75*0.4 = 0.55 ; tf = 2.5 / 1.825 = 1.36986
    const rec = makeRecord("docker compose port mapping", { ts: 0 });
    expect(scoreLine(rec, ["docker"], 10)).toBeCloseTo(1.369863, 4);
  });
});

describe("rankCandidates", () => {
  it("sorts highest score first (a line matching more terms ranks above one matching fewer)", () => {
    const candidates = [
      { record: makeRecord("just docker", { path: "/a.jsonl", line: 1 }) },
      { record: makeRecord("docker and k3s together", { path: "/b.jsonl", line: 1 }) },
    ];
    const ranked = rankCandidates(candidates, ["docker", "k3s"]);
    // the line matching BOTH terms scores higher than one matching only one
    expect(ranked[0].record.text).toContain("docker and k3s");
  });

  it("computes avgLen locally from the candidate set (no corpus scan)", () => {
    // Just confirm it runs without any stats arg and returns scored results.
    const candidates = [{ record: makeRecord("docker thing", { path: "/a.jsonl", line: 1 }) }];
    const ranked = rankCandidates(candidates, ["docker"]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it("dedups candidates with identical lineKeys", () => {
    const rec = makeRecord("docker thing", { path: "/a.jsonl", line: 1 });
    const candidates = [{ record: rec }, { record: rec }];
    expect(rankCandidates(candidates, ["docker"])).toHaveLength(1);
  });
});

describe("diversityCap", () => {
  it("caps results per file while preserving order", () => {
    const items = [
      { record: makeRecord("a", { path: "/f1.jsonl", line: 1 }) },
      { record: makeRecord("b", { path: "/f1.jsonl", line: 2 }) },
      { record: makeRecord("c", { path: "/f1.jsonl", line: 3 }) },
      { record: makeRecord("d", { path: "/f2.jsonl", line: 1 }) },
      { record: makeRecord("e", { path: "/f2.jsonl", line: 2 }) },
    ];
    const capped = diversityCap(items, 2);
    expect(capped).toHaveLength(4);
    expect(capped.map((r) => r.record.text)).toEqual(["a", "b", "d", "e"]);
  });

  it("returns all when maxPerFile >= count", () => {
    const items = [{ record: makeRecord("a", { path: "/f.jsonl", line: 1 }) }];
    expect(diversityCap(items, 3)).toHaveLength(1);
  });
});

describe("filePathOf", () => {
  it("splits path from line number", () => {
    expect(filePathOf("/home/k2/.pi/agent/sessions/--x--/s.jsonl:42")).toBe(
      "/home/k2/.pi/agent/sessions/--x--/s.jsonl",
    );
  });

  it("returns the whole string when no colon is present", () => {
    expect(filePathOf("nocolon")).toBe("nocolon");
  });
});
