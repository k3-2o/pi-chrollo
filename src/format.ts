// --- Chrollo Format Layer ---

import { Text } from "@earendil-works/pi-tui";
import type { SearchResponse } from "./search.js";

// --- Agent Context Formatting (compact: one line per result) ---

export function formatResultsForContext(response: SearchResponse): string {
  if (response.results.length === 0) {
    return "";
  }

  const lines: string[] = [];

  for (const result of response.results) {
    lines.push(`${result.sourcePath}:${result.line} | ${result.text}`);
  }

  return lines.join("\n");
}

// --- TUI Rendering ---

export function renderCall(
  args: { query?: string },
  theme: {
    fg: (style: string, text: string) => string;
    bold: (text: string) => string;
    dim: (text: string) => string;
  },
  _context?: { isError?: boolean },
): Text {
  const query = typeof args.query === "string" ? args.query : "";
  const preview = query.length > 60 ? query.slice(0, 57) + "..." : query;
  const line = theme.fg("toolTitle", theme.bold("read_memory ")) + theme.fg("dim", `"${preview}"`);
  return new Text(line, 0, 0);
}

export function renderResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: { totalMatches?: number; sessionCount?: number };
  },
  { expanded, isPartial, context }: { expanded: boolean; isPartial: boolean; context?: { isError?: boolean } },
  theme: {
    fg: (style: string, text: string) => string;
    dim: (text: string) => string;
  },
  _toolConfig: unknown,
): Text {
  if (context?.isError) {
    const errorText = result.content?.[0]?.type === "text"
      ? result.content[0].text
      : "read_memory: aborted";
    return new Text(theme.fg("error", `\u2717 ${errorText}`), 0, 0);
  }

  if (isPartial) {
    return new Text(theme.fg("warning", "Searching memories..."), 0, 0);
  }
  const d = result.details;
  const matches = d?.totalMatches ?? 0;
  const sessions = d?.sessionCount ?? 0;
  if (matches === 0) {
    return new Text(theme.fg("warning", "No matching memories"), 0, 0);
  }
  const line =
    theme.fg("success", `${matches} match${matches !== 1 ? "es" : ""}`) +
    theme.fg("dim", ` \u00b7 ${sessions} session${sessions !== 1 ? "s" : ""}`);
  if (!expanded) return new Text(line, 0, 0);
  const content = result.content[0];
  return new Text(
    line + "\n" + theme.fg("dim", content?.type === "text" ? content.text : ""),
    0,
    0,
  );
}
