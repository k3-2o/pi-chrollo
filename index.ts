// --- Chrollo - Agentic Memory for Pi ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import {
  initMemoryDir,
  findSessionFile,
  createSessionFile,
  appendTurn,
  setActiveMemoriesDir,
  type SessionFrontmatter,
} from "./src/storage.js";
import {
  grepSearch,
  proximitySearch,
  computeCorpusFrequency,
  extractDistinctiveTerms,
  invalidateCorpusCache,
} from "./src/search.js";
import { formatResultsForContext, renderCall, renderResult } from "./src/format.js";
import { extractText, formatToolCall } from "./src/capture.js";
import { getMemoryStats } from "./src/stats.js";
import {
  topicChanged,
  filterInjected,
  recordInjected,
  isTrivialPrompt,
  sameTerms,
  decideAmbientSearch,
  withInjectionBudget,
  type AmbientSearchDecision,
} from "./src/inject.js";
import { recordMetric } from "./src/metrics.js";
import { invalidateAccessCache } from "./src/access.js";

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

  let corpusFreqCache: { freq: Map<string, number>; totalFiles: number } | undefined;

  let injectedKeys: Set<string> = new Set();
  let lastDistinctTerms: Set<string> = new Set();
  let sessionMeta: PendingSession | undefined;

  // session_start

  pi.on("session_start", async (_event, ctx) => {
    setActiveMemoriesDir(ctx.cwd);
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

    corpusFreqCache = computeCorpusFrequency();

    const stats = getMemoryStats();
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Chrollo: ${stats.totalLines} memories across ${stats.sessionCount} sessions`,
        "info",
      );
    }
  });

  function ensureMemoryFile(): string | undefined {
    if (currentMemoryFile !== undefined) {
      if (fs.existsSync(currentMemoryFile)) return currentMemoryFile;
      currentMemoryFile = undefined;
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

  // agent_end

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

    if (sections.length === 0) return;

    const fullAgentText = sections.join("\n\n");

    const filePath = ensureMemoryFile();
    if (filePath === undefined) return;

    appendTurn(filePath, lastUserPrompt, fullAgentText, new Date());
    lastUserPrompt = undefined;
  });

  // before_agent_start (auto-injection)

  pi.on("before_agent_start", async (event, _ctx) => {
    lastUserPrompt = event.prompt;

    // GATE 1: skip trivial prompts (acknowledgements/greetings — no searchable content)
    if (event.prompt.length < 10 || isTrivialPrompt(event.prompt)) return;

    // Read corpus cache synchronously (pre-warmed at session_start)
    const cache = corpusFreqCache ?? computeCorpusFrequency();
    const distinctTerms = extractDistinctiveTerms(event.prompt, cache.freq, cache.totalFiles);

    if (distinctTerms.length < 2) return; // too vague for proximity

    const decision = decideAmbientSearch(distinctTerms, lastDistinctTerms, injectedKeys);
    injectedKeys = decision.injectedKeys;
    if (decision.skip) return;
    lastDistinctTerms = decision.lastDistinctTerms;

    // Proximity search with 50ms hard timeout
    try {
      const response = await withInjectionBudget(50, (signal) =>
        proximitySearch(distinctTerms, 20, signal),
      );

      if (response.results.length === 0) return;

      const fresh = filterInjected(response.results, injectedKeys);
      if (fresh.length === 0) return; // all already shown this topic

      const topResults = { ...response, results: fresh.slice(0, 10) };
      const extra = response.totalMatches - topResults.results.length;
      let memoryContext = formatResultsForContext(topResults);
      if (extra > 0) {
        memoryContext += `\n(+${extra} more — use memory intelligently)`;
      }

      recordInjected(topResults.results, injectedKeys);

      return {
        message: {
          customType: "chrollo",
          content: memoryContext,
          display: false,
        },
      };
    } catch {
      recordMetric({ kind: "inject", latencyMs: 50, resultCount: 0, aborted: true });
      return;
    }
  });

  // session_shutdown

  pi.on("session_shutdown", async (_event, _ctx) => {
    currentMemoryFile = undefined;
    lastUserPrompt = undefined;
    sessionMeta = undefined;
    corpusFreqCache = undefined;
    injectedKeys = new Set();
    lastDistinctTerms = new Set();
    invalidateCorpusCache();
    invalidateAccessCache();
  });

  // read_memory tool

  pi.registerTool({
    name: "read_memory",
    label: "Read Memory",
    description: `Search past conversations for relevant context.

Returns compact results — file:line | text. Each result is a single matching line from a memory file. It is NOT full context — it is a map marker telling you where relevant information lives. You must read the surrounding context using read <path> --offset <N> --limit <M> around each reported line. Do not treat the one-liner as sufficient.

Searches with AND mode — all search terms must appear in the same file for a match. Use distinctive keywords. If nothing comes up, try different terms or use broader recall.

Examples:
  "kanagawa palette obsidian" — search for color palette discussions
  "dotfiles brew linux" — search for linux setup memories
  "chrollo search fix" — find previous work on the search layer`,
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search terms — use distinctive keywords. All terms must appear in the same session for results. E.g. 'kanagawa palette obsidian', 'dotfiles brew linux', 'chrollo search fix'",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (signal?.aborted) {
        throw new Error("read_memory: aborted");
      }

      const response = await grepSearch(params.query, signal);
      const formatted = formatResultsForContext(response);

      if (signal?.aborted) {
        throw new Error("read_memory: aborted");
      }

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
}
