import { describe, it, expect } from "vitest";
import {
  recencyMultiplier,
  cwdBoost,
  scoreLine,
  rankCandidates,
  diversityCap,
  dedupKey,
  filterInjected,
  recordInjected,
  filePathOf,
} from "../src/rank";
import type { CorpusStats } from "../src/corpus";
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

function makeStats(over: Partial<CorpusStats> = {}): CorpusStats {
  return {
    docFreq: new Map(over.docFreq),
    avgLen: over.avgLen ?? 10,
    totalDocs: over.totalDocs ?? 100,
    fileCwd: new Map(over.fileCwd),
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
    // 7-day half-life: one week ago ≈ 1.5
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
    expect(
      scoreLine(rec, ["docker"], makeStats({ docFreq: new Map([["docker", 5]]) })),
    ).toBeGreaterThan(0);
  });

  it("scores 0 when the line contains none of the query terms", () => {
    const rec = makeRecord("docker compose port mapping");
    expect(scoreLine(rec, ["kubernetes"], makeStats())).toBe(0);
  });

  it("scores a rare term higher than a common term (at equal tf/length)", () => {
    const rec = makeRecord("alpha beta");
    const stats = makeStats({
      docFreq: new Map([
        ["alpha", 1],
        ["beta", 99],
      ]),
    });
    expect(scoreLine(rec, ["alpha"], stats)).toBeGreaterThan(scoreLine(rec, ["beta"], stats));
  });

  it("is stem-aware: query 'deployment' scores a line with 'deploy'", () => {
    const rec = makeRecord("deploy the cluster");
    const stats = makeStats({ docFreq: new Map([["deploy", 5]]) });
    // query term "deployment" -> groupWithStem -> ["deployment","deploy"]
    // line token "deploy" matches the stem form -> tf > 0 -> score > 0
    expect(scoreLine(rec, ["deployment"], stats)).toBeGreaterThan(0);
  });

  it("boosts a recent line above an old line (recency effect)", () => {
    const recent = makeRecord("docker bug", { ts: Date.now() });
    const old = makeRecord("docker bug", { ts: Date.now() - 365 * DAY_MS });
    const stats = makeStats({ docFreq: new Map([["docker", 5]]) });
    expect(scoreLine(recent, ["docker"], stats)).toBeGreaterThan(scoreLine(old, ["docker"], stats));
  });

  it("boosts a same-cwd line above a cross-cwd line", () => {
    const rec = makeRecord("docker bug");
    const stats = makeStats({ docFreq: new Map([["docker", 5]]) });
    const sameCwd = scoreLine(rec, ["docker"], stats, "/proj", "/proj");
    const crossCwd = scoreLine(rec, ["docker"], stats, "/other", "/proj");
    expect(sameCwd).toBeGreaterThan(crossCwd);
  });

  it("regression: known deterministic score (ts=0, no cwd)", () => {
    // ts=0 -> recency 1.0 ; no cwd -> boost 1.0 ; so score == pure BM25 sum.
    const rec = makeRecord("docker compose port mapping", { ts: 0 });
    const stats = makeStats({
      docFreq: new Map([
        ["docker", 5],
        ["compose", 8],
      ]),
    });
    expect(scoreLine(rec, ["docker"], stats)).toBeCloseTo(3.986812, 4);
    expect(scoreLine(rec, ["docker", "compose"], stats)).toBeCloseTo(7.377297, 4);
  });
});

describe("rankCandidates", () => {
  it("sorts highest score first", () => {
    const stats = makeStats({
      docFreq: new Map([
        ["docker", 5],
        ["k3s", 1],
      ]),
    });
    const candidates = [
      { record: makeRecord("docker thing", { path: "/a.jsonl", line: 1 }) },
      { record: makeRecord("k3s cluster", { path: "/b.jsonl", line: 1 }) }, // rare term
    ];
    const ranked = rankCandidates(candidates, ["docker", "k3s"], stats);
    // k3s is rarer -> higher IDF -> the k3s line should rank first
    expect(ranked[0].record.text).toContain("k3s");
  });

  it("dedups candidates with identical lineKeys", () => {
    const stats = makeStats();
    const rec = makeRecord("docker thing", { path: "/a.jsonl", line: 1 });
    const candidates = [{ record: rec }, { record: rec }];
    expect(rankCandidates(candidates, ["docker"], stats)).toHaveLength(1);
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
    // /f1 contributes first 2, /f2 contributes first 2; 3rd from f1 dropped
    expect(capped).toHaveLength(4);
    expect(capped.map((r) => r.record.text)).toEqual(["a", "b", "d", "e"]);
  });

  it("returns all when maxPerFile >= count", () => {
    const items = [{ record: makeRecord("a", { path: "/f.jsonl", line: 1 }) }];
    expect(diversityCap(items, 3)).toHaveLength(1);
  });
});

describe("dedup utilities", () => {
  it("dedupKey returns the lineKey", () => {
    const rec = makeRecord("x", { path: "/f.jsonl", line: 7 });
    expect(dedupKey(rec)).toBe("/f.jsonl:7");
  });

  it("filterInjected drops already-injected keys", () => {
    const injected = new Set<string>(["/f.jsonl:1"]);
    const items = [
      { record: makeRecord("a", { path: "/f.jsonl", line: 1 }) },
      { record: makeRecord("b", { path: "/f.jsonl", line: 2 }) },
    ];
    const fresh = filterInjected(items, injected);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].record.lineKey).toBe("/f.jsonl:2");
  });

  it("recordInjected adds keys to the set", () => {
    const injected = new Set<string>();
    const items = [
      { record: makeRecord("a", { path: "/f.jsonl", line: 1 }) },
      { record: makeRecord("b", { path: "/f.jsonl", line: 2 }) },
    ];
    recordInjected(items, injected);
    expect(injected.has("/f.jsonl:1")).toBe(true);
    expect(injected.has("/f.jsonl:2")).toBe(true);
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
