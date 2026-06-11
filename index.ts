// --- Chrollo - Agentic Memory for Pi ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import {
  initMemoryDir,
  findSessionFile,
  createSessionFile,
  appendTurn,
  type SessionFrontmatter,
} from "./src/storage.js";
import { grepSearch } from "./src/search.js";
import { formatResultsForContext, renderCall, renderResult } from "./src/format.js";
import { extractText, formatToolCall } from "./src/capture.js";
import { getMemoryStats } from "./src/stats.js";

// --- Types ---

interface PendingSession {
  sessionId: string;
  startDate: string;
  cwd: string;
  parentSession?: string;
}

// --- Extension entry point ---

export default function chrolloExtension(pi: ExtensionAPI): void {
  let currentMemoryFile: string | undefined;
  let pendingSession: PendingSession | undefined;
  let lastUserPrompt: string | undefined;
  let sessionMeta: PendingSession | undefined; // --- persists for file recreation on delete ---

  // --- Lifecycle: session_start ---

  pi.on("session_start", async (_event, ctx) => {
    initMemoryDir();

    const sessionId = ctx.sessionManager.getSessionId();
    const existingFile = findSessionFile(sessionId);

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

  // --- Ensure memory file exists ---

  function ensureMemoryFile(): string | undefined {
    if (currentMemoryFile !== undefined) {
      if (fs.existsSync(currentMemoryFile)) return currentMemoryFile;
      currentMemoryFile = undefined; // --- file was deleted, recreate ---
    }

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

  // --- Lifecycle: agent_end ---

  pi.on("agent_end", async (event, _ignoredCtx) => {
    if (lastUserPrompt === undefined) return;
    if (lastUserPrompt.length < 3) {
      lastUserPrompt = undefined;
      return;
    }

    const sections: string[] = [];

    for (const msg of event.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = extractText(msg.content);
        const calls: string[] = [];

        for (const block of msg.content) {
          if (block.type === "toolCall" && typeof block.name === "string") {
            formatToolCall(block.name, block.arguments, calls);
          }
        }

        if (text !== "") sections.push(text);
        if (calls.length > 0) sections.push(calls.join("\n"));
      }
    }

    // --- don't clear on empty (connection errors) ---
    if (sections.length === 0) return;

    const fullAgentText = sections.join("\n\n");

    const filePath = ensureMemoryFile();
    if (filePath === undefined) return;

    appendTurn(filePath, lastUserPrompt, fullAgentText, new Date());
    lastUserPrompt = undefined;
  });

  // --- Lifecycle: before_agent_start ---

  pi.on("before_agent_start", async (event, _ctx) => {
    lastUserPrompt = event.prompt;

    if (event.prompt.length < 10) return;

    const response = grepSearch(event.prompt);

    if (response.results.length === 0) return;

    const memoryContext = formatResultsForContext(response);

    return {
      message: {
        customType: "chrollo",
        content: memoryContext,
        display: false, // --- don't show in TUI ---
      },
    };
  });

  // --- Lifecycle: session_shutdown ---

  pi.on("session_shutdown", async (_event, _ctx) => {
    currentMemoryFile = undefined;
    lastUserPrompt = undefined;
    sessionMeta = undefined;
  });

  // --- Tool: read_memory ---

  pi.registerTool({
    name: "read_memory",
    label: "Read Memory",
    description:
      "This is your memory.Search past conversations for relevant context. Returns exact line numbers for every result line read around specific matches with read <path> --offset <N> --limit <M> to expand context instead of reading entire files.",
    promptSnippet: "Search past conversations",
    promptGuidelines: [
      "Use read_memory when you need to recall context from past conversations. Each result line includes its exact line number use read <path> --offset <N> --limit <M> to read around the lines identified.",
      "Do not read entire memory files. The returned lines with context are sufficient to answer. If you need more context, expand the reading window and radius round the line numbers until you belive youve gotten enough context don'tjust read one file read files you belive will more context but still employing this reading radius and practice. Only read an entire file if the user explicitly asks for it.",
      "Use read_memory as automatically as you use read or write reach for it without being asked, and decode indirect questions into search queries.",
      "This is your memory. Explore it, question it, build from it. Not by fetching facts, but by remembering. Indirect questions, vague asks treat them as invitations to recall. They're reasons to look back and see what connects. Use it freely.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search terms - specific keywords work best. E.g. 'React framework', 'birthday March', 'chart library'",
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

      const sessionCount = new Set(response.results.map((r) => r.source)).size;

      return {
        content: [{ type: "text", text: formatted }],
        details: {
          totalMatches: response.totalMatches,
          sessionCount,
        },
      };
    },
    renderCall,
    renderResult,
  });

  // --- Command: /recall ---

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
