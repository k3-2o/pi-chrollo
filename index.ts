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
  peekCorpusCache,
  extractDistinctiveTerms,
  invalidateCorpusCache,
} from "./src/search.js";
import { formatResultsForContext, renderCall, renderResult } from "./src/format.js";
import { extractText, formatToolCall } from "./src/capture.js";
import { getMemoryStats } from "./src/stats.js";
import { topicChanged, filterInjected, recordInjected } from "./src/inject.js";
import { recordMetric } from "./src/metrics.js";

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

  // --- Injection dedup (AD-10): remember which file:line keys we already
  //     surfaced, so follow-up turns don't re-inject the same lines. Cleared
  //     when the prompt's distinctive terms change substantially (topic shift).
  let injectedKeys: Set<string> = new Set();
  let lastDistinctTerms: Set<string> = new Set();
  let sessionMeta: PendingSession | undefined;

  // --- Lifecycle: session_start ---

  pi.on("session_start", async (_event, ctx) => {
    setActiveMemoriesDir(ctx.cwd);
    await initMemoryDir();

    const sessionId = ctx.sessionManager.getSessionId();
    const existingFile = await findSessionFile(sessionId);

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

    // Fresh corpus cache each session (AD-2): invalidate any stale module cache
    // from a prior session in this process, then pre-warm (async + persisted).
    invalidateCorpusCache();
    void computeCorpusFrequency(); // fire-and-forget warm-up; awaits on first use

    // Notify asynchronously — don't block startup on a full corpus read.
    // getMemoryStats() reads all session files; deferring it keeps the extension
    // list from hanging. The notify appears a moment later, which is fine.
    void getMemoryStats().then((stats) => {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Chrollo: ${stats.totalLines} memories across ${stats.sessionCount} sessions`,
          "info",
        );
      }
    });
  });

  // --- Ensure memory file exists ---

  async function ensureMemoryFile(): Promise<string | undefined> {
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

    currentMemoryFile = await createSessionFile(frontmatter);
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

    const filePath = await ensureMemoryFile();
    if (filePath === undefined) return;

    await appendTurn(filePath, lastUserPrompt, fullAgentText, new Date());
    // NOTE: we do NOT invalidate the corpus cache here. The cache is rebuilt at
    // session_start (fixing the cross-session staleness bug AD-2), and within a
    // session a newly-written word being absent from the freq map for one prompt
    // is harmless (it just scores as "distinctive" — which is correct). Inlining
    // an invalidate here was forcing a 58ms cache reload on EVERY prompt after
    // turn 1, causing the prompt-input lag. See docs/ARC.md.
    lastUserPrompt = undefined;
  });

  // --- Lifecycle: before_agent_start (auto-injection) ---

  pi.on("before_agent_start", async (event, _ctx) => {
    lastUserPrompt = event.prompt;

    // Skip short prompts
    if (event.prompt.length < 10) return;

    // BEST-EFFORT auto-injection: peek at the cache SYNCHRONOUSLY. Never block
    // the prompt box on a corpus read. If the cache isn't warm yet (first prompt
    // of a session, or a rebuild still in flight), skip injection for this one
    // prompt — the agent doesn't die, it just gets no ambient memory for a turn.
    // The cache is pre-warmed at session_start (fire-and-forget).
    const cache = peekCorpusCache();
    if (cache === null) return;
    const distinctTerms = extractDistinctiveTerms(event.prompt, cache.freq, cache.totalFiles);

    if (distinctTerms.length < 2) return; // too vague for proximity

    // Topic-change reset (AD-10): if this prompt shares NO distinctive term with
    // the previous one, treat it as a new topic and clear the injected-key set.
    // Cosine-free heuristic — just set intersection.
    const currentTerms = new Set(distinctTerms);
    if (topicChanged(lastDistinctTerms, currentTerms)) injectedKeys = new Set();
    lastDistinctTerms = currentTerms;

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
    invalidateCorpusCache();
    injectedKeys = new Set();
    lastDistinctTerms = new Set();
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
