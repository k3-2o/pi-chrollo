# Chrollo — Agentic Memory: Design & Architecture

> The architectural reference for Chrollo. A philosophy, not a database.

---

## 1. Thesis

### Axiom

> Don't decide what's important at write time. Store everything verbatim.
> Let the agent figure out relevance at query time.

### Key Insight

Every other memory system was designed for non-agentic retrieval — one-shot, no LLM in the loop. They optimize retrieval benchmark scores. But in agentic systems, the agent is always there. It can read, reason, iterate, and search again. This changes what a retrieval engine needs to do.

The PwC paper *"Is Grep All You Need?"* ([arXiv:2605.15184](https://arxiv.org/abs/2605.15184), May 2026) validated this: in agentic contexts, grep-based retrieval matches or exceeds vector search at near-zero cost because the agent iterates. Chrollo pushes further — no vectors, no BM25, no embeddings. Just ripgrep + WordNet thesaurus + an agent that knows how to think.

### The Approach

```
verbatim storage + grep + thesaurus + recency + agent reads + agent iterates
     = factual recall solved for the vast majority of cases at near-zero cost
```

No LLM calls at write time. No vector embeddings. No background daemon. No API keys.

---

## 2. Architecture

### Storage

- **Format:** Plain markdown files, one per Pi session
- **Location:** `~/.chrollo/memories/` (global) or `.chrollo/memories/` (per-project)
- **Content:** Every conversation turn, verbatim + tool call descriptions
- **Write mode:** Append-only, on every `agent_end`
- **File creation:** Deferred until first message with content — empty sessions leave no trace
- **Deletion policy:** Never delete raw text. Storage is cheap.

### Retrieval

Two layers, executed at query time:

```
Layer 1: ripgrep (exact string match) → ~70% of queries
Layer 2: WordNet thesaurus expansion → ripgrep again → +~20% (cumulative ~90%)
```

Results ranked by term match count, then recency-boosted:

```
recencyMultiplier = 1 + 1.0 / (daysSince + 1)
finalScore = matchedTermCount × recencyMultiplier(lineDate)
```

Each result includes full file path, ±3 lines of context, line numbers, no branding. Capped at 10 — the agent reads, reasons, and iterates if needed.

### Thesaurus

- 606 words, 3,357 synonym pairs, 46KB — ships with the extension
- Zero runtime dependencies. Loaded once at startup with `JSON.parse`.
- Integration: exact grep → no results → thesaurus expand → grep again

### Lifecycle

Three Pi hooks:

- **`before_agent_start`** — captures `lastUserPrompt`. Runs `grepSearch(prompt)` and injects relevant memories as a hidden custom message (`display: false`). Short prompts (<10 chars) skip auto-recall.
- **`agent_end`** — builds chronological sections from assistant messages (text → tool calls → text → ...). Appends turn to memory file. Creates the file on first write (lazy creation).
- **`session_shutdown`** — clears all state. No data persists between sessions.

One tool: **`read_memory(query)`** — searches past conversations via ripgrep + thesaurus. Returns lines with exact line numbers. The agent reads around matches with `read --offset --limit` rather than reading full files.

---

## 3. Storage Format

```
~/.chrollo/memories/2026-06-10_143022_019eb1a9.md
```

### Frontmatter

```yaml
---
session_id: "019eb1a9-bc39-7571-b68f-9e5ed2678d73"
date: "2026-06-10"
harness: "pi"
cwd: "/home/k2/.workspaces/chrollo"
parent_session: "/path/to/parent"   # only if forked/resumed
---
```

### Conversation format

```
[2026-06-10 14:25:36] [User]
what project are we working on

[2026-06-10 14:25:36] [Agent]
> read ~/Documents/projects/chrollo/implementation-state.md
> $ ls -la /home/k2/.workspaces/
>
> We're working on **Chrollo** — a persistent memory extension...
```

- Agent responses blockquoted so internal markdown doesn't clash
- Tool calls captured chronologically: text → tool calls → text → tool calls
- Two blank lines between turns for readability

---

## 4. Key Design Decisions

| Question | Decision | Reasoning |
|---|---|---|
| **Storage format** | Markdown (not JSONL) | Human-readable, grep-able, Obsidian-compatible. |
| **File per** | Session (not day) | Mirrors Pi's session UUID. Sessions span multiple days. |
| **File creation** | Lazy (on first message) | Empty sessions leave no trace. |
| **Tool name** | `read_memory` (not `recall_search`) | `read_` prefix aligns with model training patterns (`read`, `read_image`). |
| **`recall_add` tool** | Removed | Redundant with auto-capture. Violates "don't decide what's important." |
| **Search engine** | ripgrep (not JS loop) | 100x faster, SIMD-accelerated, scales to 100k files. |
| **Recency** | Per-line timestamps (not file mtime) | Correct recency for resumed sessions. |
| **Context window** | ±3 lines | Enough for relevance. Agent expands with `read --offset --limit`. |
| **Brand header** | Removed | The agent knows it called the tool. Noise. |
| **Aborted turns** | Not captured | User re-asks if it mattered. Partial responses are noise. |
| **Memory injection** | Ambient (`display: false`) | The agent gets context without choosing to look. No toggle — if someone forgets they turned it off, the agent goes blind and Chrollo feels broken. No preamble telling the agent "these are files on disk" — that would constrain the exact behavioral shaping the guidelines are there to build. No TUI display — that turns ambient recall into a wall of file paths every turn. The agent treats injected context as its own knowledge, or as closely held notes. That's the magic. |
| **Auto-recall threshold** | Skip prompts <10 chars | Confirmations and greetings don't need memory lookups. |
| **Connection errors** | Prompt survives empty response | `lastUserPrompt` not cleared on failed capture. Retries on reconnect. |
| **File deleted mid-session** | Auto-recreates from session metadata | No turns lost. Agent never notices. |

---

## 5. What's Not Built (And Why)

| Feature | Reason Skipped |
|---|---|
| **BM25 + Inverted Index** | Ripgrep is instant at current scale. Even at 100k+ lines, ripgrep keeps up. |
| **Embedding fallback (all-MiniLM)** | 80MB model for ~1% of queries. Thesaurus + agent iteration covers it. |
| **Config system** | No knobs to tune. Hardcoded constants work fine. |
| **Soft deletion** | Storage is cheap. Don't delete. |
| **Multi-device sync** | User brings their own (git, rsync, Dropbox). Files are plain markdown. |
| **MCP Server** | Only needed for non-Pi harnesses (Claude Code, Codex). Not yet. |
| **LLM Wiki / structured facts layer** | Karpathy's pattern works for documents — feed it an article, it writes wiki pages, you query the index. For conversation memory, the agent would have to constantly write wiki pages about what was said. This loses the raw text (phrasing, emotion, nuance) and adds an LLM call on every turn. The answer to "but structured facts" is: keep your keywords clean and the agent will find it. |
| **Memory toggle / TUI display** | Would break ambient injection. The toggle means someone forgets they turned it off — agent goes blind, Chrollo feels broken. The preamble tells the agent "this is files on disk, only use if relevant" — the exact opposite of what the prompt guidelines are building. Display in the TUI turns ambient recall into a wall of file paths and timestamps every turn. These are not bugs to patch out. The fix for injection noise is better retrieval, not a kill switch. |

---

## 6. Implementation Lessons

These decisions were made during development, shaped by real bugs and edge cases:

### Tool-using turn capture

When the agent calls `read_memory` as a tool, `event.messages` in `agent_end` doesn't contain a "user" role message — it's in an earlier turn. Fix: capture `event.prompt` in `before_agent_start` (always fires before tools), store it, use it in `agent_end` instead of searching for a "user" role.

### Chronological text + tool call order

Original code extracted all tool calls into one array and overwrote `agentText` with each assistant message. Text the agent said *before* running a tool was silently dropped. Fix: build a chronological `sections[]` array iterating all assistant messages in order. Text first, then tool calls, then more text. Never overwrite.

### Recency from line-level dates

Old format used file mtime for recency, which breaks on resumed sessions (new lines in September get August's recency). Fix: each line carries its own `[YYYY-MM-DD HH:MM:SS]` timestamp. Old files fall back to filename date. Both formats coexist.

### Lazy file creation

Original code created a file on `session_start`, leaving empty `.md` files for sessions with no conversation. Fix: store metadata on `session_start`, create zero files. `agent_end` creates the file on first meaningful write. Empty sessions leave no trace.

### File deletion resilience

If a memory file is deleted mid-session, `currentMemoryFile` goes stale. Fix: `ensureMemoryFile()` checks `fs.existsSync()` before returning. If the file is gone, recreates from persisted `sessionMeta`. A new file with the same session ID appears on the next write.

### Connection error resilience

Connection drops cause `agent_end` to fire with an incomplete `event.messages` array — the final assistant text isn't there yet. Original code extracted nothing, cleared state, lost the turn. Fix: don't clear `lastUserPrompt` on failed capture. Keep it alive. If Pi reconnects and fires another `agent_end`, retry with the same prompt.

### Separation of concerns

At ~1,000 lines, 3 files had mixed responsibilities — `index.ts` did wiring + rendering + capture helpers, `search.ts` did retrieval + output formatting, `storage.ts` did I/O + stats. Fix: redistributed into 6 single-concern modules under `src/`: capture, format, search, stats, storage, and the main index.

### Comment style

Mixed `/** JSDoc */`, `// ---`, and inline `//` comments. Fix: all comments use `// --- text ---`. Only kept vital ones: module purpose, section headers, and non-obvious edge cases.

---

## 7. Search Result Format

```
--- /home/k2/.chrollo/memories/2026-06-10_file.md:42 ---
    context text ...(line 40)
    context text ...(line 41)
→   matched text ...(line 42)
    context text ...(line 43)
```

- Full file path for direct `read` access
- Line numbers on every line for precise offset/limit navigation
- No header, no branding, no session summary — the agent knows it called the tool
- Agent guidelines: read around matches with `--offset --limit`, don't read full files
