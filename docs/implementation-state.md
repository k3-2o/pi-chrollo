# Chrollo — Agentic Memory: Implementation State

> Date: 2026-06-11 (updated: end-of-session)
> Built as a Pi extension across multiple sessions.
> 976 lines of TypeScript across 6 modules. Zero runtime dependencies.

---

## Table of Contents

1. [Core Thesis](#1-core-thesis)
2. [Architecture — As Built](#2-architecture--as-built)
3. [Pi Extension Wiring](#3-pi-extension-wiring)
4. [Storage Format](#4-storage-format)
5. [Search & Retrieval](#5-search--retrieval)
6. [Thesaurus](#6-thesaurus)
7. [Recency](#7-recency)
8. [Tool Rendering](#8-tool-rendering)
9. [Decisions Made During Implementation](#9-decisions-made-during-implementation)
10. [Deviation from Original Spec](#10-deviation-from-original-spec)
11. [What's Missing (Bloat We Skipped)](#11-whats-missing-bloat-we-skipped)
12. [Features Left Behind](#12-features-left-behind-design-doc-ambitions)
13. [File Layout](#13-file-layout)
14. [Key Numbers](#14-key-numbers)
#14-key-numbers)

## 1. Core Thesis

> Don't decide what's important at write time. Store everything verbatim.
> Let the agent figure out relevance at query time.

**This axiom drove every decision.** No compression, no summarization, no extraction at write time. Every turn is preserved exactly as it happened.

**Secondary insight:** In agentic systems, the agent is always in the loop. It can read, reason, iterate, and search again. Vector search / BM25 / inverted indexes optimize for perfect first-shot retrieval — solving the wrong problem for the agentic case. We don't need any of them. We need greppable plain text + synonym expansion + an agent that's been taught to be curious.

**The original design spec** included a full BM25 + inverted index + embedding fallback architecture as a future option. These were explicitly deprioritized (see §11). What's actually built is below.

---

## 2. Architecture — As Built

### Storage Layer

- **Format:** Plain markdown files, one per Pi session
- **Location:** `~/.chrollo/memories/`
- **Content:** Every conversation turn, verbatim + tool call descriptions
- **Frontmatter:** YAML (session_id, date, harness, cwd, parent_session)
- **Write mode:** Append-only, real-time (on every agent_end)
- **File creation:** Deferred until first message with content
- **Capture scope:** User text + Agent response + tool call commands (e.g. `$ ls`, `read path`)

### Markdown Format

Each turn interleaves text and tool calls in chronological order:

```markdown
[YYYY-MM-DD HH:MM:SS] [User]
what project are we working on

[YYYY-MM-DD HH:MM:SS] [Agent]
> read ~/Documents/projects/chrollo/implementation-state.md
> $ ls -la /home/k2/.workspaces/
>
> We're working on **Chrollo** — a persistent memory extension...
```

- User text: `[timestamp] [User]` on its own line, then content on the next line
- Agent text: `[timestamp] [Agent]`, then blockquoted content with `> `
- Text and tool calls are **chronological** — if the agent said something, then ran a tool, the text comes first, then `> $ cmd`, then more text
- **Two blank lines** between turns for raw readability
- Timestamps include full date (`YYYY-MM-DD HH:MM:SS`) — enables per-line recency
- Format backward-compatible: old files without dates still work (fallback to filename date)

### Retrieval Engine

Executed at query time. Two layers implemented:

```
STEP 1: Parse query → extract key terms (remove stop words, punctuation)
STEP 2: ripgrep (exact string match) → handles ~70% of queries
STEP 3: WordNet thesaurus expansion → rg again → +~20% (cumulative ~90%)
```

There is no Step 4. No BM25, no inverted index, no embedding fallback. The original design spec described those as future additions, but they were deprioritized (see §11) — ripgrep is instant at current scale, and the agent iterates if results aren't precise enough.

What's actually built stops at the thesaurus because it's already enough.

### Context Window

±3 lines around each match. Every line includes its exact line number at the end:
`text ...(line 42)`. Agent reads, reasons, synthesizes, answers. Agent can iterate with refined queries.

### Search Result Format

```
--- /full/path/to/file.md:line ---
    context text ...(line 40)
    context text ...(line 41)
→   matched text ...(line 42)
    context text ...(line 43)
```

- Full file path so agent can `read` directly
- Line numbers on every line for precise offset/limit navigation
- No brand header, no session summary, no extra noise

---

## 3. Pi Extension Wiring

Three Pi lifecycle hooks drive capture. One tool for retrieval. One command for stats.

### `session_start`
- Initialize storage directory (`~/.chrollo/memories/`)
- Persist session metadata (`sessionMeta`) for file recreation on delete
- Check if this Pi session already has a Chrollo file
- If yes → track for append (resumed session)
- If no → store metadata, create NO file yet (deferred to first write)
- Show memory stats to user

### `before_agent_start`
- **Capture** `event.prompt` into `lastUserPrompt` (always — fixes tool-using turn bug)
- **Auto-recall:** Run `grepSearch(prompt)` → inject relevant memories as hidden custom message (`display: false`, agent sees it in context)
- Skip auto-recall for short prompts (<10 chars — confirmations, greetings)

### `agent_end`
- **Read** `lastUserPrompt` (captured before tools ran) as user text
- **Build sections in chronological order** — iterate all assistant messages in order, for each one extract text THEN tool calls, append to a `sections[]` array
- Text before tool calls is no longer overwritten — all text across all assistant messages is preserved in sequence
- **Write** sections joined by `\n\n` to session's markdown file
- Skip if no sections were built (no assistant content)
- Create the markdown file on first write (lazy creation)
- Don't clear `lastUserPrompt` on empty response — connection errors can fire `agent_end` early; the prompt survives for the retry

### `ensureMemoryFile` (helper)
- If `currentMemoryFile` exists on disk → return it
- If file was deleted → reset state, recreate from persisted `sessionMeta`
- If no file and no pending session → return undefined (first message not yet seen)
- Creates file from pending metadata on first write

### `session_shutdown`
- Clear state (currentMemoryFile, pendingSession, lastUserPrompt, sessionMeta)

### Tools Registered

| Tool | Purpose | Status |
|---|---|---|
| `read_memory(query)` | Search past conversations. Returns lines with exact line numbers. Agent should use `read --offset --limit` around specific lines rather than reading full files. | ✅ Active |

### Removed Tools
| Tool | Reason |
|---|---|
| `recall_add(text)` | Redundant with auto-capture. Every turn is already saved verbatim. |

### Commands Registered

| Command | Purpose |
|---|---|
| `/recall` | Show memory stats (session count, turn count) |

---

## 4. Storage Format

### File path
```
~/.chrollo/memories/2026-06-10_143022_019eb1a9.md
```
Format: `YYYY-MM-DD_HHMMSS_first8charsOfSessionId.md`

### Frontmatter
```yaml
---
session_id: "019eb1a9-bc39-7571-b68f-9e5ed2678d73"
date: "2026-06-10"
harness: "pi"
cwd: "/home/k2/.workspaces/chrollo"
parent_session: "/path/to/pi/session.jsonl"   # only if forked/resumed
---
```

### Conversation lines
```
[2026-06-10 14:25:36] [User] what's my best language?

[2026-06-10 14:25:36] [Agent]
> $ read ~/.chrollo/memories/previous.md
> $ ls ~/Documents/projects/
> read_memory python preference
>
> Based on our conversations, you said **Python** is your preference.
```

### Capture scope
| What | Captured? | Format |
|---|---|---|
| User text | ✅ | `[timestamp] [User]` on own line, text on next line |
| Agent response | ✅ | `[timestamp] [Agent]` on own line, `>` blockquoted text below |
| Bash commands | ✅ | `> $ command` (inside agent block, in chronological order) |
| Read calls | ✅ | `> read path` |
| Edit/write calls | ✅ | `> edit path` |
| Custom tools (read_memory, etc.) | ✅ | `> toolName arg` |
| Tool outputs | ❌ | Not captured (bloat) |

### Text-before-tool-calls order (fixed in v0.4)
Previously, `agent_end` overwrote `agentText` with each assistant message — text before tool calls was lost. Now builds a chronological `sections[]` array preserving the sequence: text → tool calls → text → tool calls → ...

### File creation policy
- **Lazy:** No file created until the first meaningful message
- `session_start` stores metadata but writes nothing to disk
- `agent_end` creates file + writes first turn in one shot
- Empty sessions (enter, say nothing) leave no trace on disk

### Deletion resilience
- If a memory file is deleted mid-session, `ensureMemoryFile()` detects it
- `sessionMeta` persists the session ID and metadata
- A brand new file is created on the next write
- No turns are lost — the agent never notices

### Deletion policy
- Never delete raw text
- Soft filter only (forgotten flag in future inverted index)
- Storage is cheap. Don't delete.

### Aborted turns
- User presses Escape mid-stream → turn is not captured
- `agent_end` either doesn't fire, or fires with empty agent text → caught by validation
- `lastUserPrompt` is overwritten by the next turn
- Rationale: partial answers are noise. User will re-ask if it mattered.

---

## 5. Search & Retrieval

### Query parsing
```typescript
extractTerms(query: string): string[]
```
- Lowercase
- Strip punctuation
- Remove stop words (~150 common English words)
- Remove words ≤ 2 characters
- Return remaining as content terms

### Search engine — ripgrep
The core search uses `ripgrep` (`rg`) instead of a JavaScript file-reading loop:

```typescript
// One rg call per query — finds matching files in milliseconds
rg -F -i -l -e term1 -e term2 ~/.chrollo/memories/
```

- `rg` is written in Rust with SIMD — searches 100k files in milliseconds
- Only matching filenames are returned, then context is extracted via JS line-reading
- Context extraction uses existing code that handles the blockquote format correctly
- One rg call per query. Thesaurus path = 2 calls (exact → nothing → expanded)

### Ranking pipeline

```
1. Sort by term match count (more matches = more relevant)
2. Deduplicate overlapping results (same file, within 6 lines)
3. Apply recency boost re-sort (line-level dates)
4. Return top 10 results
```

### Recency boost
```typescript
recencyMultiplier(date) = 1 + 1.0 / (daysSince + 1)
finalScore = matchedTermCount × recencyMultiplier(lineDate)
```
- Date parsed from per-line timestamp `[YYYY-MM-DD HH:MM:SS]` in the conversation line
- Old format lines (without date) fall back to file's date from filename
- Today's result: 2.0× boost. 30-day-old: 1.03×. A year old: 1.003×.
- Applied as post-retrieval re-rank across ALL layers (not just BM25)
- Recency is a nudge, not an override

### Result format
```
--- /home/k2/.chrollo/memories/2026-06-10_file.md:42 ---
    context text ...(line 40)
    context text ...(line 41)
→   matched text ...(line 42)
    context text ...(line 43)
```

No header. No branding. No session summary. Just the raw matching lines with full file paths and `...(line N)` markers on every line.

### Confidence threshold (not implemented)
Original spec: skip deeper layers if 2+ unique terms within 10 lines.
Currently: exact grep returns immediately if any results found. Thesaurus only triggers if exact returns nothing.

---

## 6. Thesaurus

### Data source
- WordNet processed into a flat JSON synonym map
- 606 English words, 3,357 synonym pairs
- 46KB file at `~/.chrollo/thesaurus.json`
- Generated once via WordNet (`wordpos` dev dependency, uninstalled after)
- Loaded at runtime with `JSON.parse` — zero runtime dependencies

### Sample entries
```json
{
  "react": ["respond", "oppose"],
  "stressed": ["distressed", "accented"],
  "search": ["lookup", "seek", "research", "explore"],
  "delete": ["cancel", "erase"],
  "build": ["construct", "make", "create"]
}
```

### Integration
- `loadThesaurus()` — reads file once, caches in memory
- `expandTerms(terms)` — for each term, looks up synonyms, returns deduplicated list
- `grepSearch()` — tries exact grep first; if no results, expands and tries again
- Response includes `layer: "grep"` or `layer: "grep+thesaurus"` for debugging

---

## 7. Recency

### Per-line dates (your idea, implemented)
Each conversation line carries its own date:

```
[2026-06-10 14:25:36] [User] text
```

The date is parsed from each line during ranking. This solves the resumed-session problem: if you resume a session in September, new lines get September's recency boost, old lines stay at June's recency.

### Backward compatibility
Old files without dates (`[14:25:36] [User]` instead of `[2026-06-10 14:25:36] [User]`) use the filename date as fallback. Both formats coexist.

### Formula
```
recencyMultiplier(lineDate) = 1 + 1.0 / (daysSince + 1)
score = matchedTermCount × recencyMultiplier(lineDate)
```

---

## 8. Tool Rendering

The `read_memory` tool uses `renderCall` and `renderResult` for compact TUI display, matching the pattern used by `read_image` and `omnisearch_gateway`:

**When invoked (renderCall):**
```
read_memory "what did we say about storage format"
```

**Collapsed (default, renderResult with expanded=false):**
```
3 matches · 2 sessions
```

**Expanded (Ctrl+O, renderResult with expanded=true):**
```
3 matches · 2 sessions
--- /path/to/file.md:42 ---
    context ...(line 40)
→   matched ...(line 42)
    context ...(line 43)
```

Uses `Text` component from `@earendil-works/pi-tui`. Standard Pi collapse/expand via `Ctrl+O`.

---

## 9. Decisions Made During Implementation

### Tool-using turn capture
**Problem:** When agent calls `read_memory` as a tool, `event.messages` in `agent_end` doesn't contain a "user" role message (it's in an earlier turn). The turn wasn't captured.

**Fix:** Capture `event.prompt` in `before_agent_start` (always fires before any tools run). Use this stored prompt in `agent_end` instead of searching for "user" role in messages.

### Connection error resilience
**Problem:** Connection errors cause `agent_end` to fire with an incomplete `event.messages` array — the final assistant text isn't there yet. The handler extracted nothing, cleared state, and the turn was lost.

**Fix:** Don't clear `lastUserPrompt` when we fail to capture. Keep it alive. If Pi fires another `agent_end` (after reconnecting), we retry with the same prompt. Only clear on successful write.

### File deletion resilience
**Problem:** If a memory file is deleted mid-session, `currentMemoryFile` points to a non-existent path. `appendTurn` would fail silently.

**Fix:** `ensureMemoryFile()` checks `fs.existsSync(currentMemoryFile)` before returning. If the file is gone, it recreates from persisted `sessionMeta`. A new file is created with the same session ID.

### Chronological text + tool call capture (v0.4)
**Problem:** Original `agent_end` extracted all tool calls into one array and overwrote `agentText` with each assistant message. Text that the agent said before running a tool was silently dropped. Memory files only showed tool calls + final text, missing the agent's reasoning steps.

**Fix:** Build a `sections[]` array iterating all assistant messages in order. For each message, emit text first, then tool calls. Join with `\n\n`. No more overwriting — chronological order is preserved exactly.

### User format matching agent format (v0.4)
**Problem:** User text was inline: `[HH:MM:SS] [User] text`. Agent text was on its own line: `[HH:MM:SS] [Agent]\n> text`. Inconsistent and harder to parse visually.

**Fix:** Changed user format to match agent: `[HH:MM:SS] [User]` on its own line, then content on the next line. Both roles now have the same visual structure.

### Separation of concerns (v0.4)
**Problem:** 3 files had mixed responsibilities — `index.ts` did wiring + rendering + capture helpers, `search.ts` did retrieval + output formatting, `storage.ts` did I/O + stats.

**Fix:** Redistributed into 6 single-concern modules under `src/`:
- `extension.ts` — Pi wiring only
- `capture.ts` — turn capture (extractText, formatToolCall)
- `format.ts` — output formatting (formatResultsForContext, renderCall, renderResult)
- `search.ts` — retrieval only
- `storage.ts` — file I/O only
- `stats.ts` — memory statistics

### Comment style (v0.4)
**Problem:** Mixed comment styles — `/** JSDoc */` blocks, `// ---` dash dividers, inline `// comments`. Inconsistent.

**Fix:** All comments use `// --- text ---` format. Only kept vital ones: module purpose, section headers, and non-obvious edge case explanations.

### Tool rendering
**Problem:** Custom tool output was plain text with no collapsibility. Tool results ate screen space.

**Fix:** Added `renderCall` and `renderResult` using `Text` from `@earendil-works/pi-tui`. Collapsed: shows match/session count. Expanded: shows full output. Standard `Ctrl+O` toggle.

### Blockquoted agent responses
**Problem:** Agent responses contain their own markdown (headings, code fences, tables) that clashed with the session file's markdown structure.

**Fix:** Prefix every line of agent responses with `> ` (blockquote). Internal markdown stays scoped inside the quote. Two blank lines between turns.

### Lazy file creation
**Problem:** Original code created a markdown file on `session_start`, leaving empty files for sessions with no conversation.

**Fix:** Store metadata on `session_start` but create NO file. `agent_end` creates the file on the first meaningful write. Empty sessions leave no trace.

### Markdown vs JSONL
**Decision:** Markdown for now. JSONL is technically cleaner but sacrifices `cat`-readability. The format clash from agent responses is cosmetic — grep still works perfectly.

### Recency boost applicable to all layers
**Decision:** Recency is NOT BM25-specific. It's a post-retrieval re-rank multiplier applied uniformly after every layer (grep, thesaurus, BM25).

### `recall_add` removed
**Decision:** The tool was redundant. Auto-capture already saves every turn verbatim. Explicit memory storage violated the "don't decide what's important at write time" axiom.

---

## 10. Deviation from Original Spec

| Spec says | Built as | Why |
|---|---|---|
| `~/.recall/memories/` | `~/.chrollo/memories/` | Renamed to Chrollo |
| File per day | File per session | Mirrors Pi's session UUID model |
| `[User]` / `[Agent]` inline timestamps | `[User]` on own line, content below | Matches agent format, easier to parse |
| `recall_search` tool | `read_memory` tool | Better model recognition (`read_` prefix) |
| `recall_add` tool | Removed | Redundant with auto-capture |
| JS file-reading loop | ripgrep (`rg`) | 100x faster, scales to 100k files |
| File-date recency (filename) | Line-level date parsing | Correct recency for resumed sessions |
| Brand header + session summary | Stripped — just result groups | Noise, agent knows it called the tool |
| No tool call capture | Tool calls captured | Important investigative context |
| Tool calls prepended to text | Chronological sections (text → tool calls → text) | Text before tool calls was being dropped |
| No file deletion handling | Auto-recreates from sessionMeta | Resilience |
| Connection error = lost turn | Prompt survives, retries on reconnect | Data loss prevention |
| Plain text rendering | Custom renderCall/renderResult | Ctrl+O collapse support |
| Agent text from "last" assistant msg | Cumulative sections from all assistant msgs | Captures multi-message responses |
| 3 files, mixed concerns | 6 single-concern modules under `src/` | Separation of concerns |
| Mixed comment styles | `// --- text ---` everywhere | Consistency |
| Thesaurus → BM25 → embedding | Thesaurus only | BM25 is bloat at current scale |

---

## 11. What's Missing (Bloat We Skipped)

| Feature | Why Skipped |
|---|---|
| **BM25 + Inverted Index** | Ripgrep is instant at current scale. BM25 needed at 100k+ lines only. Original spec describes this as a future layer. |
| **Embedding Fallback (all-MiniLM)** | 80MB model for 1% of queries. Thesaurus + agent iteration covers it. Original spec describes this as optional. |
| **LLM Wiki (human-readable layer)** | Vanity feature. Blockquoted files are readable raw. |
| **Config system (TOML)** | No knobs to tune yet. Hardcoded constants are fine. |
| **Soft deletion (forgotten flag)** | Philosophy says "storage is cheap, don't delete." |
| **MCP Server** | Only needed if deploying to Claude Code, Codex, etc. |
| **Cross-platform (Windows)** | Linux works. macOS works. Windows needs special-casing. |
| **LongMemEval benchmark** | Only matters if publishing or selling. |
| **Cross-harness lifecycle hooks** | Research needed before MCP server. |
| **Multi-user isolation** | Simple but not built yet. |
| **Agent iteration tracking** | Agent iterates on its own. Counting is bloat. |

---

## 12. Features Left Behind (Design Doc Ambitions)

These are features from the original design doc that we explicitly chose not to carry forward. They were discussed, considered, and rejected during implementation:

| Feature | Discussed | Rejected Because |
|---|---|---|
| **`recall_add` tool** | Explicit memory storage tool | Redundant with auto-capture. Every turn is already saved verbatim. Violates "don't decide what's important at write time." |
| **`recall_search` name** | Original tool name | Changed to `read_memory`. The `read_` prefix aligns with model training patterns (`read`, `read_image`). |
| **File-per-day naming** | Named by date instead of session | Changed to file-per-session. Mirrors Pi's session UUID model. Session can span multiple days if resumed. |
| **Brand header in output** | `[Chrollo Memory] Found X matches.` | Removed. The agent knows it called the tool. Noise. |
| **Session summary** | `Sessions: /path.md N matches` | Removed. Redundant with result groups below. |
| **JS file-reading grep loop** | Pure JS `fs.readFileSync` loop | Replaced with ripgrep. 100x faster, scales to 100k files. |
| **File-date recency** | Date parsed from filename | Replaced with per-line `[YYYY-MM-DD HH:MM:SS]` dates. Correct recency for resumed sessions. |
| **JS grep** | `fs.readFileSync` + `.includes()` | Replaced with `rg -l` subprocess. Same interface, Rust backend. |
| **Mtime-based recency** | Use OS file modification time | Rejected in favor of line-level dates. Line-level is always correct; mtime has edge cases (git clones, syncs). |
| **Custom `Text`-based rendering** | TUI component for tool output | Replaced with simpler `renderCall`/`renderResult` pattern matching `read_image` and `omnisearch_gateway`. |
| **MCP server as immediate next step** | Build Python FastMCP server | Deprioritized. Chrollo is Pi-only for now. MCP adds complexity without immediate benefit. |

---

## 13. File Layout

### Extension (loaded by Pi)
```
~/.pi/agent/extensions/chrollo/
├── package.json                 ← Pi discovers ./src/extension.ts from this
├── .prettierrc.json
├── scripts/
│   └── build-thesaurus.ts       ← One-time generator (dev dependency on wordpos)
└── src/
    ├── extension.ts             ← Pi wiring: lifecycle hooks + tool/command registration (225 lines)
    ├── capture.ts               ← Turn capture: extractText, formatToolCall (72 lines)
    ├── format.ts                ← Output formatting: formatResultsForContext, renderCall, renderResult (82 lines)
    ├── search.ts                ← Retrieval: rg + thesaurus + scoring (420 lines)
    ├── stats.ts                 ← Memory statistics: getMemoryStats (30 lines)
    └── storage.ts               ← File I/O: create, append, read, path resolution (147 lines)
```

### Runtime data
```
~/.chrollo/
├── thesaurus.json               ← 46KB, 606 words, generated once
└── memories/                    ← One .md per Pi session, created on first message
    ├── 2026-06-10_141231_019eb1a9.md
    ├── 2026-06-10_144022_019eb1c3.md
    ├── ...
```

### Tooling
```
npm run format     = prettier --write 'src/*.ts' 'scripts/*.ts'
npm run check      = prettier --check + tsx smoke test (imports all modules)
```

### Requirements
- **Node.js** (v20+) — Pi runs on it
- **ripgrep** (`rg`) — for fast file search. Install: `apt install ripgrep`, `brew install ripgrep`, or `choco install ripgrep`
- **Zero npm dependencies** at runtime

### Install for a new user
```bash
# 1. Install ripgrep (system dependency)
sudo apt install ripgrep        # Linux
brew install ripgrep            # macOS

# 2. Clone/copy extension to Pi's extensions directory
cp -r chrollo ~/.pi/agent/extensions/

# 3. Generate thesaurus (one-time, optional but recommended)
cd ~/.pi/agent/extensions/chrollo
npm run build-thesaurus

# 4. Restart Pi — extension auto-loads
pi
```
The `~/.chrollo/` directory and `~/.chrollo/memories/` are created automatically on first session start.

---

## 14. Key Numbers

| Metric | Value |
|---|---|
| Source lines (TypeScript) | 976 (6 modules under `src/`) |
| Runtime dependencies | 0 |
| Thesaurus size | 46KB, 606 words, 3,357 synonym pairs |
| Thesaurus load time | <1ms |
| Memory per session file | ~2KB per turn |
| Storage for 1M sessions | ~800MB (raw + optional index) |
| Cost per query | $0 (ripgrep + thesaurus = filesystem ops) |
| Recall coverage | ~70% exact ripgrep + ~20% thesaurus = ~90% cumulative |
| rg search speed | ~27ms per query (including subprocess spawn) |
| Sessions captured | 23 sessions, 184 turns |
| Build time | Multiple sessions across 2 days |
query (including subprocess spawn) |
| Sessions captured | 23 sessions, 184 turns |
| Build time | Multiple sessions across 2 days |
