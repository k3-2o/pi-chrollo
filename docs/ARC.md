# Chrollo — Agentic Memory: Design & Architecture

> The architectural reference for Chrollo. A philosophy, not a database.

---

## 1. Thesis

### Axiom

> Don't decide what's important at write time. Store everything verbatim.
> Let the agent figure out relevance at query time.

### Key Insight

Every other memory system was designed for non-agentic retrieval — one-shot, no LLM in the loop. They optimize retrieval benchmark scores. But in agentic systems, the agent is always there. It can read, reason, iterate, and search again. This changes what a retrieval engine needs to do.

The PwC paper *"Is Grep All You Need?"* ([arXiv:2605.15184](https://arxiv.org/abs/2605.15184), May 2026) validated this: in agentic contexts, grep-based retrieval matches or exceeds vector search at near-zero cost because the agent iterates. Chrollo pushes further — no vectors, no BM25, no embeddings. Just ripgrep + light stemming + an agent that knows how to think.

### The Approach

```
verbatim storage + grep + stemming + recency + agent reads + agent iterates
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

Three layers, executed at query time, each a single ripgrep pass:

```
Layer 1: single-pass AND  — one rg call, all terms must co-occur (file-level)
Layer 2: trigram typo fallback — on AND-miss, OR across 3-char sub-patterns
Layer 3: the agent iterates — re-search with different words (axiom 2)
```

Term extraction splits camelCase / snake_case / kebab-case identifiers (so
`optimizeRerenders` is searchable as "optimize") and applies light stemming
(`deployment`→`deploy`; ripgrep `-F` substring-matching then catches every
inflection at once). A corpus-frequency filter drops words appearing in >30%
of files. The frequency index is a **synchronous module-level cache**, built
once at `session_start` (~280ms) and reused for every prompt that session;
cleared at `session_shutdown` so the next session rebuilds fresh.

Results ranked by **distinct** matched-term count, then recency-boosted:

```
recencyMultiplier = 1 + exp(-daysSince / 43)   // ~30-day half-life
finalScore = distinctMatchedTerms × recencyMultiplier(lineDate)
```

Per-file diversity cap (max 3 from any one session), global cap at 20.

### ~~Thesaurus~~ (removed in 0.2.0)

Chrollo previously shipped a WordNet thesaurus (606 words, 3,357 pairs) as a
fallback. It was **removed** because WordNet lists every sense of a word, so
the fallback injected irrelevant synonyms (`build`→`physique`, `code`→`encipher`,
`application`→`lotion`) and *required* them to co-occur — narrowing results to
noise exactly when help was most needed. Light stemming + the agent iterating
with different words covers the morphological cases without the polysemy cost.

### Lifecycle

Three Pi hooks:

- **`before_agent_start`** — captures `lastUserPrompt`. Runs `grepSearch(prompt)` and injects relevant memories as a hidden custom message (`display: false`). Short prompts (<10 chars) skip auto-recall.
- **`agent_end`** — builds chronological sections from assistant messages (text → tool calls → text → ...). Appends turn to memory file. Creates the file on first write (lazy creation).
- **`session_shutdown`** — clears all state. No data persists between sessions.

One tool: **`read_memory(query)`** — searches past conversations via single-pass AND + trigram fallback. Returns lines with exact line numbers. The agent reads around matches with `read --offset --limit` rather than reading full files.

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
| **Embedding fallback (all-MiniLM)** | 80MB model for ~1% of queries. Stemming + trigram + agent iteration covers it. |
| **Config system** | No knobs to tune. Hardcoded constants work fine. |
| **Soft deletion** | Storage is cheap. Don't delete. |
| **Multi-device sync** | User brings their own (git, rsync, Dropbox). Files are plain markdown. |
| **MCP Server** | Only needed for non-Pi harnesses (Claude Code, Codex). Not yet. |
| **LLM Wiki** | Karpathy's pattern works for documents — feed it an article, it writes wiki pages, you query the index. For conversation memory, the agent would have to constantly write wiki pages about what was said. This loses the raw text (phrasing, emotion, nuance) and adds an LLM call on every turn. The answer to "but structured facts" is: keep your keywords clean and the agent will find it. |
| **Thesaurus (removed in 0.2.0)** | WordNet polysemy made it net-negative (`build`→`physique`, `code`→`encipher`). Stemming covers morphology; the agent iterates for true synonyms. The only revival path is a hand-curated dev/tech synonym map, and only if synonym-recall failures are demonstrated after stemming ships. |
| **`read_memory` "expand" mode** | The deliberate design is "return compact `path:line \| text` markers; agent reads around them." An expand mode (return ±N lines directly) duplicates the `read` tool's job and muddies the clean abstraction. |
| **Reconnect double-append fix (held)** | The capture-retry path can append a turn twice on reconnect. Held pending a plain-language walkthrough before implementing (the fix is a debounce; see SPEC §10.1). |
| **Auto-tag capture (held)** | Regex-extracting the first identifier/proper-noun into a `#tag` line at write time. Could improve recall across paraphrase; held pending understanding the value (see SPEC §10.2). |
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

### 0.2.0 — the correctness / recall / reliability pass

A full adversarial audit surfaced a cluster of latent bugs; each is recorded as an
Architectural Decision (AD-n) in `.vscode/SPEC.md`. The non-obvious ones:

- **Timezone bug in recency** (AD-1): timestamps were *written* in local time
  (`getHours()`) but *read* as UTC (string-concat `…Z`). Users ahead of UTC saw
  today's memories parsed as "future" → zero recency boost. Fix: read local via
  the `Date(Y,M-1,D,h,m,s)` constructor. No file-format change.
- **Stale corpus-frequency cache** (AD-2): the module-level cache survived across
  sessions in Pi's long-running process. Fix: clear it at `session_shutdown`, so
  the next `session_start` rebuilds it fresh (synchronously).
- **Single-pass AND** (AD-4): the old search spawned N ripgrep processes (one per
  term) serially. Replaced with one `rg --json` pass + JS file-level AND.
- **30-day recency half-life** (AD-5): the inverse curve decayed too fast.
- **Code-aware tokenizer** (AD-6): identifiers were mashed into un-greppable blobs.
- **Thesaurus removed** (AD-7): WordNet polysemy made it net-negative.
- **Metrics sidecar** (AD-13): `.chrollo/metrics.jsonl` records latency + aborts.
- **Async I/O (AD-8) — REVERTED:** 0.2.0 originally converted the whole storage
  layer to `fs/promises` (async). It was reverted because it destroyed the
  atomicity the Pi event handlers rely on: `session_start` could no longer
  guarantee the corpus cache was warm before returning, so `before_agent_start`
  awaited a ~1.9s rebuild and froze the prompt box on the first prompt of every
  session. Sync I/O in handlers that must run atomically is not a bug. The
  pure-logic work (tokenizer, recency, etc.) was kept; only the async/persisted
  machinery was rolled back.
- **Persisted corpus cache (`.chrollo/freq.json`) — REVERTED:** shipped
  alongside AD-8, reverted with it for the same atomicity reason. The corpus
  frequency is now a plain synchronous module cache (once per session).

### Known limitation surfaced by metrics (post-0.2.0)

The metrics sidecar exposed that `proximitySearch` (the auto-injection path) on
a ~285-file corpus takes **~200ms clean** — well over its 50ms budget. In other
words, auto-injection is **consistently aborting** at this corpus size, silently
injecting nothing. This was previously invisible; it is now recorded as
`"aborted":true`. The 50ms budget is a tuning constant (`INJECT_BUDGET_MS`) —
raising it (e.g. to 250ms) trades a little rendering latency for actual recall.
Not changed in 0.2.0 (out of approved scope); flagged for the next pass.

---

## 7. Search Result Format

```
/home/k2/.chrollo/memories/2026-06-10_file.md:42 | matched text
/home/k2/.chrollo/memories/2026-06-15_file.md:19 | other matched text
(+3 more — use memory intelligently)
```

- Full file path for direct `read` access
- One line per result: `path:line | text`
- No context lines, arrows, or `(line N)` tags — saves ~70% tokens per result
- Auto-injection appends `(+N more — use memory intelligently)` when additional matches exist
- Agent guidelines: read around matches with `--offset --limit`, don't read full files
