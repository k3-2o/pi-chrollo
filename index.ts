// --- Chrollo — Retrieval layer over Pi's native sessions (0.4.2) ---
//
// A read-only retrieval layer. Searches Pi's .jsonl session files with ripgrep
// + BM25, renders matched windows readably. Does NOT capture, store, inject,
// or compress. See .vscode/SPEC.md for the architecture pivot rationale.
//
// Workflow enforced by the two tools:
//   1. agent calls search_memory(query) → path:line markers
//   2. agent calls read_memory(path, offset, limit?) → readable window
// `offset` is REQUIRED on read — there is no whole-file dump path.

import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { search } from "./src/search.js";
import { read, READ_LIMIT_DEFAULT, READ_LIMIT_CAP } from "./src/read.js";

export default function chrolloExtension(pi: ExtensionAPI): void {
  pi.registerTool(createSearchMemoryTool());
  pi.registerTool(createReadMemoryTool());
}

const searchParams = Type.Object({
  query: Type.String({
    description:
      "2–4 distinctive keywords — names, identifiers, rare terms. OR-matched, overlap-ranked. E.g. 'k3s ingress traefik'.",
  }),
});

export function createSearchMemoryTool(): ToolDefinition<typeof searchParams> {
  // No session-scoped state. search is stateless across calls; there is no
  // capture, no injection, no cache, and no cwd boost.

  // --- search_memory ---
  // Returns path:line | role: preview markers. The agent picks one and feeds
  // its :line into read_memory's offset.
  return {
    name: "search_memory",
    label: "Search Memory",
    description: `Search past Pi conversations for relevant turns. Use when the user references earlier work, prior decisions, or a session current context can't answer — and when resuming a project, before re-exploring or re-asking. Returns \`path:line\` markers, never content: follow each marker with read_memory. Queries are OR-matched, so 2–4 rare terms (identifiers, proper nouns) outrank many common words.`,
    promptSnippet: "Search past Pi conversations (path:line markers; follow with read_memory)",
    promptGuidelines: [
      "Reach for this when the user says 'remember when', 'we discussed', 'that session about' — or whenever work resumes on a topic that may have history, even if they don't ask.",
      "Query with 2–4 distinctive keywords — names, identifiers, rare terms. Common words only widen the net.",
      "Every result is a marker. Follow up with read_memory to actually read the context.",
    ],
    parameters: searchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("search_memory: aborted");
      // Exclude the current session's own file — the agent already has that
      // context live in its context window; surfacing it as a top match just
      // crowds out older, actually-useful sessions.
      const excludePath = ctx.sessionManager.getSessionFile();
      try {
        // signal is wired into the rg child (execFile signal option): Esc kills it.
        const results = await search(params.query, { excludePath, signal });
        if (signal?.aborted) throw new Error("search_memory: aborted");

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No memories found matching: "${params.query}"` }],
            details: { totalMatches: 0 },
          };
        }

        const text =
          results.join("\n") +
          `\n\nEach line is a marker. Call read_memory with the path and the line number (offset) to see the surrounding context.`;

        return {
          content: [{ type: "text", text }],
          details: { totalMatches: results.length },
        };
      } catch (err) {
        if (signal?.aborted) throw new Error("search_memory: aborted");
        // Killed-but-empty is a slow-disk hiccup, never "no memories".
        if ((err as Error)?.message === "search timed out") {
          return {
            content: [
              {
                type: "text",
                text: `Search timed out — ripgrep exceeded the backstop while scanning a cold or slow disk and produced no results yet. This is a startup hiccup, not an empty store; retry the search.`,
              },
            ],
            details: { error: "search_timeout" },
          };
        }
        throw err;
      }
    },
    renderCall(args: { query?: string }, theme: Theme): Text {
      const q = typeof args.query === "string" ? args.query : "";
      const preview = q.length > 60 ? q.slice(0, 57) + "…" : q;
      return new Text(
        theme.fg("toolTitle", theme.bold("search_memory ")) + theme.fg("dim", `"${preview}"`),
        0,
        0,
      );
    },
    renderResult(
      result: { content?: Array<{ type: string; text?: string }> },
      { isPartial }: { expanded: boolean; isPartial: boolean },
      theme: Theme,
    ): Text {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
      const n = (result.content?.[0]?.text ?? "").split("\n").filter((l) => l.includes("|")).length;
      return new Text(theme.fg("success", `✓ ${n} match${n === 1 ? "" : "es"}`), 0, 0);
    },
  };
}

const readParams = Type.Object({
  path: Type.String({
    description: "Session file path from a search_memory marker.",
  }),
  offset: Type.Integer({
    description: "1-based line number from a search_memory marker.",
    minimum: 1,
  }),
  limit: Type.Optional(
    Type.Integer({
      description: `Lines to read. Default ${READ_LIMIT_DEFAULT}, max ${READ_LIMIT_CAP}.`,
      minimum: 1,
      maximum: READ_LIMIT_CAP,
    }),
  ),
});

export function createReadMemoryTool(): ToolDefinition<typeof readParams> {
  // --- read_memory ---
  // Renders a bounded window [offset, offset+limit) of a session file readably.
  // `offset` is REQUIRED — there is no whole-file read. Use the :line from a
  // search_memory marker.
  return {
    name: "read_memory",
    label: "Read Memory",
    description: `Read a bounded window of a past Pi session, rendered as \`[HH:MM] role: text\` lines with tool calls summarized and noise skipped. Take path and offset from a search_memory marker — offset is the marker's line number; there is no whole-file read.`,
    promptSnippet: "Read a past session around a search_memory marker (offset required)",
    promptGuidelines: [
      "After each search_memory, read the marker's window — the preview line is rarely enough to act on.",
      "Never guess path or offset; both come from the marker.",
    ],
    parameters: readParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // offset is schema-required (Type.Integer, not Optional), so a missing
      // offset is rejected by the framework before reaching here. The
      // teaching message below is a defensive backstop for malformed calls.
      if (typeof params.offset !== "number" || params.offset < 1) {
        return {
          content: [
            {
              type: "text",
              text: "offset is required and must be ≥ 1. Use search_memory to find a path:line marker first, then pass that line number as offset.",
            },
          ],
          details: { error: "missing_or_invalid_offset" },
        };
      }

      const result = read(params.path, params.offset, params.limit ?? READ_LIMIT_DEFAULT);

      if ("error" in result) {
        return {
          content: [{ type: "text", text: result.error }],
          details: { error: result.error },
        };
      }

      if (result.text.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Nothing renderable at ${params.path}:${params.offset} (the window may be empty, contain only metadata, or be past EOF).`,
            },
          ],
          details: { lines: 0 },
        };
      }

      const text =
        result.text + (result.truncated ? `\n[...${READ_LIMIT_CAP}-line cap hit...]` : "");
      return {
        content: [{ type: "text", text }],
        details: { lines: result.lines, truncated: result.truncated },
      };
    },
    renderCall(args: { path?: string; offset?: number; limit?: number }, theme: Theme): Text {
      const p = typeof args.path === "string" ? args.path : "";
      const off = typeof args.offset === "number" ? args.offset : "?";
      // Shorten the path to its last segment for a scannable tool row.
      const short = p.split("/").slice(-2).join("/");
      return new Text(
        theme.fg("toolTitle", theme.bold("read_memory ")) + theme.fg("dim", `${short}:${off}`),
        0,
        0,
      );
    },
    renderResult(
      result: { details?: { lines?: number; error?: string; truncated?: boolean } },
      { isPartial }: { expanded: boolean; isPartial: boolean },
      theme: Theme,
    ): Text {
      if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);
      if (result.details?.error) {
        return new Text(theme.fg("error", `✗ ${result.details.error.slice(0, 80)}`), 0, 0);
      }
      const lines = result.details?.lines ?? 0;
      const note = result.details?.truncated ? " (truncated)" : "";
      return new Text(theme.fg("success", `✓ ${lines} line${lines === 1 ? "" : "s"}${note}`), 0, 0);
    },
  };
}
