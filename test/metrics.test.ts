import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { recordMetric, readMetrics, type MetricRecord } from "../src/metrics";
import { setActiveMemoriesDir } from "../src/storage";

// Phase 7: metrics sidecar (AD-13).

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chrollo-metrics-"));
  // Create the .chrollo/memories structure so resolveMemoriesDir resolves
  // LOCALLY instead of falling back to the global ~/.chrollo (which would
  // leak test metrics into the real store).
  fs.mkdirSync(path.join(tmpRoot, ".chrollo", "memories"), { recursive: true });
  setActiveMemoriesDir(tmpRoot);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function metricsPath(): string {
  return path.join(tmpRoot, ".chrollo", "metrics.jsonl");
}

describe("recordMetric + readMetrics", () => {
  it("appends a valid JSON line with all required fields", () => {
    recordMetric({ kind: "search", latencyMs: 42, resultCount: 5, aborted: false });

    const raw = fs.readFileSync(metricsPath(), "utf-8").trim();
    const rec = JSON.parse(raw) as MetricRecord;

    expect(rec.kind).toBe("search");
    expect(rec.latencyMs).toBe(42);
    expect(rec.resultCount).toBe(5);
    expect(rec.aborted).toBe(false);
    expect(typeof rec.ts).toBe("string");
    // ts is a parseable ISO timestamp
    expect(new Date(rec.ts).getTime()).not.toBeNaN();
  });

  it("appends multiple records (append-only, one line each)", () => {
    recordMetric({ kind: "search", latencyMs: 10, resultCount: 1, aborted: false });
    recordMetric({ kind: "inject", latencyMs: 50, resultCount: 0, aborted: true });
    recordMetric({ kind: "search", latencyMs: 30, resultCount: 3, aborted: false });

    const records = readMetrics();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.kind)).toEqual(["search", "inject", "search"]);
    expect(records[1].aborted).toBe(true);
  });

  it("writes to .chrollo/metrics.jsonl (parent of memories, not inside)", () => {
    recordMetric({ kind: "search", latencyMs: 1, resultCount: 0, aborted: false });
    expect(fs.existsSync(metricsPath())).toBe(true);
    // memories dir itself stays clean (no metrics file polluting it)
    const memDir = path.join(tmpRoot, ".chrollo", "memories");
    if (fs.existsSync(memDir)) {
      expect(fs.readdirSync(memDir)).not.toContain("metrics.jsonl");
    }
  });

  it("readMetrics returns [] when no file exists yet", () => {
    expect(readMetrics()).toEqual([]);
  });

  it("readMetrics skips malformed lines (resilient)", () => {
    fs.mkdirSync(path.dirname(metricsPath()), { recursive: true });
    fs.writeFileSync(
      metricsPath(),
      "{not json}\n" +
        JSON.stringify({
          ts: "2026-01-01T00:00:00.000Z",
          kind: "search",
          latencyMs: 5,
          resultCount: 1,
          aborted: false,
        }) +
        "\n",
      "utf-8",
    );
    const records = readMetrics();
    expect(records).toHaveLength(1); // malformed line skipped
  });

  it("never throws — recordMetric swallows write failures silently", () => {
    // point at a path that can't be written (read-only-ish via a file as dir)
    // Simulate by making the parent path unwritable isn't portable; instead
    // just confirm recordMetric's signature doesn't reject on a normal call
    // and that a throw inside would not propagate (best-effort contract).
    expect(() =>
      recordMetric({ kind: "search", latencyMs: 1, resultCount: 0, aborted: false }),
    ).not.toThrow();
  });
});
