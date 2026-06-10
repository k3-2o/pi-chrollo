/**
 * Chrollo — Agentic Memory for Pi
 *
 * A Pi extension that captures conversations into verbatim markdown files
 * and provides grep-based retrieval across all past sessions.
 *
 * Core axiom: never decide what's important at write time.
 * Store everything verbatim. Let the agent + retrieval figure out relevance.
 *
 * Lifecycle:
 *   session_start   → init storage, show memory stats
 *   agent_end       → append conversation lines to session file
 *   before_agent_start → auto-search memories, inject into context
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import {
  initMemoryDir,
  findSessionFile,
  createSessionFile,
  appendTurn,
  getMemoryStats,
  type SessionFrontmatter,
} from "./storage.js";
import { grepSearch, formatResultsForContext } from "./search.js";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

interface PendingSession {
  sessionId: string;
  startDate: string;
  cwd: string;
  parentSession?: string;
}

export default function chrolloExtension(pi: ExtensionAPI): void {
  let currentMemoryFile: string | undefined;
  let pendingSession: PendingSession | undefined;
  let lastUserPrompt: string | undefined;
  let sessionMeta: PendingSession | undefined; // persists for file recreation on delete

  // -----------------------------------------------------------------------
  // Lifecycle: session_start — just store metadata, don't create file yet
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    initMemoryDir();

    const sessionId = ctx.sessionManager.getSessionId();
    const existingFile = findSessionFile(sessionId);

    // Always store session metadata for potential file recreation
    sessionMeta = {
      sessionId,
      startDate: new Date().toISOString(),
      cwd: ctx.cwd,
      parentSession: ctx.sessionManager.getHeader()?.parentSession ?? undefined,
    };

    if (existingFile !== undefined) {
      currentMemoryFile = existingFile;
      pendingSession = undefined;
    } else {
      // Defer file creation until first actual message
      currentMemoryFile = undefined;
      pendingSession = { ...sessionMeta };
    }

    const stats = getMemoryStats();
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Chrollo: ${stats.totalLines} memories across ${stats.sessionCount} sessions`,
        "info",
      );
    }
  });

  // -----------------------------------------------------------------------
  // Ensure a memory file exists — create from pending metadata if needed
  // -----------------------------------------------------------------------

  function ensureMemoryFile(): string | undefined {
    // If current file exists on disk, use it
    if (currentMemoryFile !== undefined) {
      if (fs.existsSync(currentMemoryFile)) return currentMemoryFile;
      // File was deleted — recreate from session metadata
      currentMemoryFile = undefined;
    }

    // Restore pending session from persisted metadata if available
    if (pendingSession === undefined && sessionMeta !== undefined) {
      pendingSession = { ...sessionMeta };
    }

    if (pendingSession === undefined) return undefined;

    const frontmatter: SessionFrontmatter = {
      sessionId: pendingSession.sessionId,
      startDate: pendingSession.startDate,
      harness: "pi",
      cwd: pendingSession.cwd,
      parentSession: pendingSession.parentSession,
    };

    currentMemoryFile = createSessionFile(frontmatter);
    pendingSession = undefined;
    return currentMemoryFile;
  }

  // -----------------------------------------------------------------------
  // Lifecycle: agent_end — capture conversation, create file on first write
  // -----------------------------------------------------------------------

  pi.on("agent_end", async (event, _ignoredCtx) => {
    // Use the prompt captured in before_agent_start (handles tool-using turns)
    if (lastUserPrompt === undefined) return;
    if (lastUserPrompt.length < 3) {
      lastUserPrompt = undefined;
      return;
    }

    // Extract tool calls and assistant text from all messages
    const toolCalls: string[] = [];
    let agentText = "";

    for (const msg of event.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // Also capture the final response text
        const text = extractText(msg.content);
        if (text !== "") agentText = text;

        // Extract tool calls from assistant content blocks
        for (const block of msg.content) {
          if (block.type === "toolCall" && typeof block.name === "string") {
            formatToolCall(block.name, block.arguments, toolCalls);
          }
        }
      }
    }

    // Don't clear lastUserPrompt on empty agent text — connection errors can
    // fire agent_end early with no assistant response. Keeping the prompt alive
    // lets the retried agent_end (after reconnect) still capture the turn.
    if (agentText === "") return;

    // Prepend tool calls to agent text
    const fullAgentText =
      toolCalls.length > 0 ? toolCalls.join("\n") + "\n\n" + agentText : agentText;

    // Create file on first meaningful message — not before
    const filePath = ensureMemoryFile();
    if (filePath === undefined) return;

    appendTurn(filePath, lastUserPrompt, fullAgentText, new Date());
    lastUserPrompt = undefined; // clear for next turn
  });

  // -----------------------------------------------------------------------
  // Lifecycle: before_agent_start — capture prompt + auto-recall memories
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event, _ctx) => {
    // Always capture the raw prompt — this is the user text we write later
    lastUserPrompt = event.prompt;

    // Auto-recall: skip short prompts (confirmations, greetings)
    if (event.prompt.length < 10) return;

    const response = grepSearch(event.prompt);

    if (response.results.length === 0) return;

    const memoryContext = formatResultsForContext(response);

    // Inject as a custom message that the agent sees in context
    return {
      message: {
        customType: "chrollo",
        content: memoryContext,
        display: false, // Don't show in TUI — it's noise for the user
      },
    };
  });

  // -----------------------------------------------------------------------
  // Lifecycle: session_shutdown — cleanup
  // -----------------------------------------------------------------------

  pi.on("session_shutdown", async (_event, _ctx) => {
    currentMemoryFile = undefined;
    lastUserPrompt = undefined;
    sessionMeta = undefined;
  });

  // -----------------------------------------------------------------------
  // Custom tool: read_memory — deep context retrieval for the agent loop
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "read_memory",
    label: "Read Memory",
    description:
      "Search past conversations for relevant context. Returns exact line numbers for every result line \u2014 read around specific matches with read <path> --offset <N> --limit <M> to expand context instead of reading entire files.",
    promptSnippet: "Search past conversations",
    promptGuidelines: [
      "Use read_memory when you need to recall context from past conversations. Each result line includes its exact line number \u2014 use read <path> --offset <N> --limit <M> to read around the lines identified.",
      "Do not read entire memory files. The returned lines with context are sufficient to answer. If you need more context, expand the reading window around the line numbers. Only read an entire file if the user explicitly asks for it.",
      "Use read_memory as automatically as you use read or write \u2014 reach for it without being asked, and decode indirect questions into search queries.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search terms — specific keywords work best. E.g. 'React framework', 'birthday March', 'chart library'",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const response = grepSearch(params.query);
      const formatted = formatResultsForContext(response);

      if (formatted === "") {
        return {
          content: [
            {
              type: "text",
              text: `No memories found matching: "${params.query}"`,
            },
          ],
          details: { totalMatches: 0, sessionCount: 0 },
        };
      }

      // Count unique sessions from results
      const sessionCount = new Set(response.results.map((r) => r.source)).size;

      return {
        content: [{ type: "text", text: formatted }],
        details: {
          totalMatches: response.totalMatches,
          sessionCount,
        },
      };
    },
    renderCall(args, theme, _context) {
      const query = typeof args.query === "string" ? args.query : "";
      const preview = query.length > 60 ? query.slice(0, 57) + "..." : query;
      const line =
        theme.fg("toolTitle", theme.bold("read_memory ")) + theme.fg("dim", `"${preview}"`);
      return new Text(line, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, _context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Searching memories..."), 0, 0);
      }
      const d = result.details as { totalMatches?: number; sessionCount?: number };
      const matches = d?.totalMatches ?? 0;
      const sessions = d?.sessionCount ?? 0;
      if (matches === 0) {
        return new Text(theme.fg("warning", "No matching memories"), 0, 0);
      }
      const line =
        theme.fg("success", `${matches} match${matches !== 1 ? "es" : ""}`) +
        theme.fg("dim", ` · ${sessions} session${sessions !== 1 ? "s" : ""}`);
      if (!expanded) return new Text(line, 0, 0);
      const content = result.content[0];
      return new Text(
        line + "\n" + theme.fg("dim", content?.type === "text" ? content.text : ""),
        0,
        0,
      );
    },
  });

  // -----------------------------------------------------------------------
  // User command: /recall — browse memory stats
  // -----------------------------------------------------------------------

  pi.registerCommand("recall", {
    description: "Show Chrollo memory statistics",
    handler: async (_args, ctx) => {
      const stats = getMemoryStats();
      ctx.ui.notify(
        `Chrollo: ${stats.totalLines} memories across ${stats.sessionCount} sessions`,
        "info",
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: format tool calls for capture in memory files
// ---------------------------------------------------------------------------

function formatToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  output: string[],
): void {
  switch (name) {
    case "bash": {
      const cmd = args?.command;
      if (typeof cmd === "string") {
        output.push(`$ ${cmd}`);
      }
      break;
    }
    case "read":
    case "read_memory":
    case "grep":
    case "find":
    case "ls": {
      const parts: string[] = [name];
      if (args) {
        for (const val of Object.values(args)) {
          if (typeof val === "string") {
            parts.push(val);
            break;
          }
        }
      }
      output.push(parts.join(" "));
      break;
    }
    case "edit":
    case "write": {
      const path = args?.path ?? args?.file;
      if (typeof path === "string") {
        output.push(`${name} ${path}`);
      } else {
        output.push(name);
      }
      break;
    }
    default: {
      const firstArg = args ? Object.values(args).find((v) => typeof v === "string") : undefined;
      if (typeof firstArg === "string") {
        output.push(`${name} ${firstArg}`);
      } else {
        output.push(name);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: extract text from message content
// ---------------------------------------------------------------------------

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      parts.push(block.text.trim());
    }
  }

  return parts.join("\n").trim();
}
