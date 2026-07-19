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
  type AmbientSearchDecision,
} from "./src/inject.js";
import { recordMetric } from "./src/metrics.js";
import { invalidateAccessCache } from "./src/access.js";

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

  // --- Cache corpus frequency for term extraction across the session.
  //     Pre-warmed SYNCHRONOUSLY at session_start so before_agent_start always
  //     finds it warm (no async race, no prompt-box freeze). Computed once per
  //     session (~280ms at startup, NOT per-prompt). ---
  let corpusFreqCache: { freq: Map<string, number>; totalFiles: number } | undefined;

  // --- Injection dedup (AD-10): remember which file:line keys we already
  //     surfaced, so follow-up turns don't re-inject the same lines. Cleared
  //     when the prompt's distinctive terms change substantially (topic shift).
  let injectedKeys: Set<string> = new Set();
  let lastDistinctTerms: Set<string> = new Set();
  let sessionMeta: PendingSession | undefined;

  // --- Lifecycle: session_start ---

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

    // Pre-warm corpus frequency cache SYNCHRONOUSLY so every prompt this
    // session finds it warm. (~280ms once at startup — not per-prompt.)
    corpusFreqCache = computeCorpusFrequency();

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

    if (sections.length === 0) return;

    const fullAgentText = sections.join("\n\n");

    const filePath = ensureMemoryFile();
    if (filePath === undefined) return;

    appendTurn(filePath, lastUserPrompt, fullAgentText, new Date());
    lastUserPrompt = undefined;
  });

  // --- Lifecycle: before_agent_start (auto-injection) ---

  pi.on("before_agent_start", async (event, _ctx) => {
    lastUserPrompt = event.prompt;

    // --- GATE 1 (Phase 10A): skip trivial prompts. Acknowledgements, greetings,
    //     thanks, continuations carry nothing worth a memory search. Skipping
    //     them keeps the 50ms budget for prompts that actually need it.
    if (event.prompt.length < 10 || isTrivialPrompt(event.prompt)) return;

    // Read the corpus cache SYNCHRONOUSLY. It was pre-warmed at session_start,
    // so this is always instant — no async, no mid-handler yield, no prompt-box
    // freeze. (The async await here is what broke 0.2.0.)
    const cache = corpusFreqCache ?? computeCorpusFrequency();
    const distinctTerms = extractDistinctiveTerms(event.prompt, cache.freq, cache.totalFiles);

    if (distinctTerms.length < 2) return; // too vague for proximity

    // Topic-change reset (AD-10) + Gate 2 (Phase 10A): pure decision.
    const decision = decideAmbientSearch(distinctTerms, lastDistinctTerms, injectedKeys);
    injectedKeys = decision.injectedKeys;
    if (decision.skip) return;
    lastDistinctTerms = decision.lastDistinctTerms;

    // Proximity search with hard 50ms timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);

    try {
      const response = await proximitySearch(distinctTerms, 20, controller.signal);

      if (response.results.length === 0) return;

      // Dedup: drop lines we already injected on a prior turn of this topic.
      const fresh = filterInjected(response.results, injectedKeys);
      if (fresh.length === 0) return; // all already shown this topic

      // Inject max 10 results + lightweight heads-up if more exist
      const topResults = { ...response, results: fresh.slice(0, 10) };
      const extra = response.totalMatches - topResults.results.length;
      let memoryContext = formatResultsForContext(topResults);
      if (extra > 0) {
        memoryContext += `\n(+${extra} more — use memory intelligently)`;
      }

      // Record what we just injected so the next turn can skip it.
      recordInjected(topResults.results, injectedKeys);

      return {
        message: {
          customType: "chrollo",
          content: memoryContext,
          display: false,
        },
      };
    } catch {
      // timeout or abort — skip ambient injection, but record it so the
      // 50ms budget failures are visible in metrics.jsonl (AD-13).
      recordMetric({
        kind: "inject",
        latencyMs: 50, // the budget that was exceeded
        resultCount: 0,
        aborted: true,
      });
      return;
    } finally {
      clearTimeout(timer);
    }
  });

  // --- Lifecycle: session_shutdown ---

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

  // --- Tool: read_memory ---

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
