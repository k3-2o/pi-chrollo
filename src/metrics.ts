// Chrollo Metrics (AD-13). Append-only JSONL observability for search + injection.
// `grep '"aborted":true' .chrollo/metrics.jsonl` shows how often the 50ms
// auto-injection timeout fires. Best-effort: write failures are swallowed.

import * as fs from "node:fs";
import * as path from "node:path";
import { getMemoriesDir } from "./storage.js";

export interface MetricRecord {
  ts: string; // ISO timestamp
  kind: "search" | "inject";
  latencyMs: number;
  resultCount: number;
  aborted: boolean;
}

function metricsPath(): string {
  return path.join(path.dirname(getMemoriesDir()), "metrics.jsonl");
}

// Append one metric record. Best-effort — failures silently ignored so
// metrics can never break the search/inject path.
export function recordMetric(rec: Omit<MetricRecord, "ts">): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec } satisfies MetricRecord);
  try {
    const p = metricsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, line + "\n", "utf-8");
  } catch {
    // best-effort: metrics must never throw
  }
}

// Read + parse all metric records (for inspection / tests). Best-effort.
export function readMetrics(): MetricRecord[] {
  try {
    const raw = fs.readFileSync(metricsPath(), "utf-8");
    const records: MetricRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        records.push(JSON.parse(line) as MetricRecord);
      } catch {
        // skip malformed lines
      }
    }
    return records;
  } catch {
    return [];
  }
}
