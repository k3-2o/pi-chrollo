// --- Chrollo — Retrieval layer over Pi's native sessions (0.3.0) ---
//
// A read-only retrieval layer. Searches Pi's .jsonl session files with ripgrep
// + BM25, renders matched windows readably. Does NOT capture, store, inject,
// or compress. See .vscode/SPEC.md for the architecture pivot rationale.
//
// Workflow enforced by the two tools:
//   1. agent calls search_memory(query) → path:line markers
//   2. agent calls read_memory(path, offset, limit?) → readable window
// `offset` is REQUIRED on read — there is no whole-file dump path.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { search, SearchInterruptedError } from "./src/search.js";
import { read, READ_LIMIT_DEFAULT, READ_LIMIT_CAP } from "./src/read.js";

export default function chrolloExtension(pi: ExtensionAPI): void {
  // The only session-scoped state: the current cwd, used as a same-project
  // boost signal for ranking. No capture, no injection, no metrics.
  let sessionCwd: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
  });

  pi.on("session_shutdown", async () => {
    sessionCwd = undefined;
    // No cache to clear — the corpus-stats scan that needed invalidation is
    // permanently gone (SPEC §3.3). search is stateless across calls.
  });

  // --- search_memory ---
  // Returns path:line | role: preview markers. The agent picks one and feeds
  // its :line into read_memory's offset.
  pi.registerTool({
    name: "search_memory",
    label: "Search Memory",
    description: `Search past Pi sessions for relevant context.

Returns compact results: one line per match, formatted as \`<session-path>:<line> | <role>: <preview>\`. Each result is a MAP MARKER, not the full content — you must follow up with read_memory using the path and the line number as offset to see the surrounding context.

Searches your entire Pi session history (~/.pi/agent/sessions). Terms are OR-matched by ripgrep and BM25-ranked: \`docker compose port\` matches any line containing docker, compose, OR port — so FEWER, RARER terms beat many common ones. Structural filtering drops tool outputs and metadata automatically — only real conversation turns are returned.

Query hygiene: prefer 2–4 distinctive keywords (proper nouns, identifiers, rare terms). \`chrollo slander\` beats \`the chrollo slander session we had\` — the extra words widen the net without improving rank.

Examples:
  "chrollo slander"          — find the session where we discussed chrollo's flaws
  "docker compose port"      — find past docker-compose debugging
  "k3s ingress traefik"      — find k3s cluster work`,
    promptSnippet:
      "Search past Pi sessions for relevant context (returns path:line markers; follow up with read_memory)",
    promptGuidelines: [
      "Use search_memory FIRST whenever the user references past work or prior sessions ('remember when', 'we discussed', 'that session about', 'go back to'), AND whenever you resume a project or topic that may have history — even if the user doesn't explicitly ask. Checking memory before re-exploring code or re-asking questions saves redundant work.",
      "Use 2–4 distinctive keywords (proper nouns, identifiers, rare terms like 'k3s' or 'chrollo'). Terms are OR-matched: adding common words (the, about, thing, session) only widens the net, never narrows it.",
      "Every result is a marker (\`path:line | preview\`), not the content. Always follow up with read_memory using the marker's line number as offset to actually read the context.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Distinctive keywords from the topic you're looking for. All terms are OR-matched by ripgrep; results are BM25-ranked. E.g. 'docker compose port', 'chrollo slander', 'BM25 scorer'.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("search_memory: aborted");
      // Exclude the current session's own file — the agent already has that
      // context live in its context window; surfacing it as a top match just
      // crowds out older, actually-useful sessions.
      const excludePath = ctx.sessionManager.getSessionFile();
      try {
        // signal is wired into the rg child (execFile signal option): Esc kills it.
        const results = await search(params.query, { sessionCwd, excludePath, signal });
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
        if (
          err instanceof SearchInterruptedError ||
          (err as Error)?.name === "SearchInterruptedError"
        ) {
          return {
            content: [
              {
                type: "text",
                text: `Search timed out — ripgrep hit the 30s backstop while scanning a cold or slow disk and had not produced any results when it was stopped. This is a startup hiccup, not an empty store. The session corpus is now partly cached, so retrying this search usually succeeds; if it keeps timing out, try narrower keywords.`,
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
  });

  // --- read_memory ---
  // Renders a bounded window [offset, offset+limit) of a session file readably.
  // `offset` is REQUIRED — there is no whole-file read. Use the :line from a
  // search_memory marker.
  pi.registerTool({
    name: "read_memory",
    label: "Read Memory",
    description: `Read a window of a past Pi session, rendered readably.

REQUIRES \`offset\` — there is no whole-file read. Get the path and offset from a search_memory result marker (the \`<path>:<line>\` prefix). Returns \`[HH:MM] role: text\` lines plus compact \`> toolName(args)\` summaries; tool outputs and internal thinking are skipped automatically.

Parameters:
  path   — the session file path from a search_memory marker
  offset — the 1-based line number from the marker (the part after the last colon)
  limit  — optional, default ${READ_LIMIT_DEFAULT}, max ${READ_LIMIT_CAP}`,
    promptSnippet: "Read a bounded window of a past session (offset required)",
    promptGuidelines: [
      "Use read_memory after every search_memory to read the context around a marker — pass the marker's line number as offset.",
      "Never guess a path or offset for read_memory — always obtain them from a prior search_memory result.",
      "The one-line preview from search_memory rarely contains enough to act on. Reading the surrounding window is almost always worth the call.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Full session file path (from a search_memory marker).",
      }),
      offset: Type.Integer({
        description:
          "1-based line number to start reading at. Copy this from the marker's `:line` suffix.",
        minimum: 1,
      }),
      limit: Type.Optional(
        Type.Integer({
          description: `Number of lines to read. Default ${READ_LIMIT_DEFAULT}, max ${READ_LIMIT_CAP}.`,
          minimum: 1,
          maximum: READ_LIMIT_CAP,
        }),
      ),
    }),
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
  });
}
