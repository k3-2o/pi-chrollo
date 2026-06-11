# Chrollo — Things to Explore & Open Trade-offs

> Current status: Pi-native extension working (v0.4). 976 lines across 6 modules.
> Storage format: **Markdown** with per-line dates, user on own line.
> Implementation doc: [`implementation-state.md`](implementation-state.md) — what's actually built.
> Architecture reference: [`ARCHITECTURE.md`](ARCHITECTURE.md) — design decisions and background.
> Last sync: 2026-06-11.

---

## 1. Storage Format: Markdown vs JSONL

### Markdown (chosen, with per-line dates)

```
~/.chrollo/memories/2026-06-10_141231_019eb1a9.md
```

```markdown
---
session_id: "019eb1a9-..."
date: "2026-06-10"
---
[2026-06-10 14:25:36] [User]
what's my best language?

[2026-06-10 14:25:36] [Agent]
> read_memory python preference
> $ ls ~/Documents/projects/
>
> Based on our conversations, you said **Python** is your preference.
```

### Pros
- Human-readable with `cat`
- grep-able natively
- Blockquoted agent responses — internal markdown doesn't clash
- Tool calls captured inline
- Per-line dates for correct recency across resumed sessions
- Zero dependencies to read or write

### Cons
- Agent responses contain full markdown which can clash with file structure
- Adding fields (tags, provenance) requires format extension
- Structured data requires regex parsing

### JSONL (under consideration)
Would make parsing trivial. Would lose `cat`-readability. Not urgent.

### Decision
**Markdown.** JSONL if structured metadata becomes critical.

---

## 2. Provenance Tracking

**Status: Open, partially implemented.**

Search results include the full file path but not the explicit `session_id` from YAML frontmatter.

**Options:**
- Parse `session_id` from YAML frontmatter during search and include in `SearchResult`
- File path already encodes the session prefix — agent can cross-reference
- For JSONL: include as a field on every line

---

## 3. Aborted Turns (User Hits Escape Mid-Response)

**Status: Decided — do not capture.**

User aborts mid-stream → turn not saved. User will re-ask if it mattered. Partial answers are noise.

**Connection errors:** `lastUserPrompt` survives empty `agentText`. If Pi reconnects and fires another `agent_end`, the prompt is still there.

---

## 4. Thesaurus Expansion (WordNet)

**Status: ✅ Implemented.**

606 words, 3,357 synonym pairs. 46KB JSON at `~/.chrollo/thesaurus.json`. Zero runtime deps.
Exact ripgrep → nothing found → thesaurus expand → try again.

---

## 5. Recency Boost

**Status: ✅ Implemented (line-level).**

`score = matchedTerms × (1 + 1.0 / (daysSince + 1))`

Each line carries `[YYYY-MM-DD HH:MM:SS]`. Old format (no date) falls back to filename.
Applied uniformly across all layers. Nudge, not override.

---

## 6. Known Issues (Not Yet Addressed)

| Issue | Severity |
|---|---|
| **"No matching memories" bug** — auto-inject found 1117 matches but `read_memory` returned nothing in one session. Possibly a state issue with the tool querying a different directory. | Medium — needs investigation |
| **Session transition drops last turn** — `/fork` mid-response could clear `lastUserPrompt` before write | Low — edge case |
| **Corrupted file recovery** — if a file gets truncated mid-write, no retry mechanism | Low — hasn't happened |

### Fixed in v0.4
- **Text before tool calls was lost** — ✅ Fixed. Now builds chronological `sections[]` array preserving order.
- **User text inline with role** — ✅ Fixed. `[User]` now on its own line matching agent format.
- **parseFileDate / parseLineDate code clone** — ✅ Fixed. Shared `tryParseDate` helper.

---

## 7. Path Forward — Current Priority

1. ✅ **Foundation** — Markdown + ripgrep + recency + thesaurus (done)
2. ⬜ **Investigate "No matching memories" bug** — check if tool and auto-inject use the same search path
3. ⬜ **Provenance** — Include `session_id` in search results
4. ⬜ **MCP Server (Python)** — Only if going multi-harness (Claude Code, Codex, etc.)
5. ⬜ **Inverted index + BM25** — Only if >100k lines (likely never needed)
6. ⬜ **LongMemEval benchmark** — Only if publishing or selling

---

## 8. Interesting But Not Necessary

These are features that were discussed, would be fun to build, but aren't needed for Chrollo to work well. Consider them only if you're bored or have a specific need:

| Feature | Why It's Interesting | Why It's Not Necessary |
|---|---|---|
| **MCP Server (deep dive)** | Full Python FastMCP server exposing read_memory, memory list, and lifecycle hooks. Would make Chrollo work with Claude Code, Codex, Gemini CLI, Cursor, etc. | Only useful if you use other harnesses. Pi-only doesn't need it. Add when you multi-harness. |
| **Cross-harness lifecycle hooks** | Research Claude Code/Codex/Gemini APIs to build equivalent auto-capture outside Pi. Required before MCP server can offer auto-inject. | Prerequisite for MCP. Same bucket — only matters if multi-harness. |
| **Domain-specific thesaurus** | Swap/customize WordNet for medical, legal, or code terminology | WordNet covers general conversation well. Only matters if you work in a specialized domain. |
| **Embedding fallback (all-MiniLM)** | Catch conceptual matches the thesaurus misses (1% edge case) | 80MB model download, CPU latency, solves almost nothing. Thesaurus + agent iteration covers it. |
| **LLM Wiki layer** | Auto-compiled wiki from raw sessions, browsable in Obsidian | Raw files are already readable and grepable. Wiki would fall out of sync. |
| **Multi-user isolation** | Separate memory directories per user on shared machines | Single-user use case. Trivial to add if needed. |
| **Cross-platform (Windows paths)** | Path normalization for Windows users | Works on Linux and macOS. Windows users can add path tweaks. |
| **Soft deletion (forgotten flag)** | Hide specific memories without deleting data | Philosophy says don't delete. "Storage is cheap." |
| **Config system (TOML)** | Tunable knobs for all variables | No knobs need tuning. Hardcoded constants work fine. |
| **Agent iteration tracking** | Count and limit how many times the agent re-queries | Agent iterates on its own. Counting is overhead with no benefit. |
| **Confidence threshold** | Skip thesaurus if exact grep already found strong matches | Current check (if anything found, return) is simpler and works the same. |

---

## Decisions Locked

| Question | Decision |
|---|---|
| Storage format | Markdown with per-line dates, user on own line |
| File creation | Lazy — on first message, not session start |
| File deleted mid-session | Auto-recreates from session metadata |
| Aborted turns | Do not capture |
| Connection errors | Prompt survives, retries on reconnect |
| Capture scope | User + Agent text + tool calls (not outputs) |
| Capture order | Chronological sections (text → tool calls → text → ...) — no overwriting |
| User format | `[timestamp] [User]` on own line, content below |
| Recency | Per-line dates, applied uniformly across all layers |
| Thesaurus | Pre-built JSON from WordNet, zero runtime deps |
| Tool name | `read_memory` (was `recall_search`) |
| `recall_add` | Removed (redundant with auto-capture) |
| Grep engine | ripgrep (`rg`) |
| Tool rendering | Custom renderCall/renderResult, Ctrl+O collapse |
| Output format | Line numbers at end `...(line N)`, full paths, no header |
| Tool guidelines | Read around `--offset --limit`, don't read full files |
| Code organization | 6 single-concern modules under `src/` |
| Comment style | `// --- text ---` everywhere |
| BM25 + Inverted Index | Skipped — premature, likely never needed |
| Embeddings | Off by default, probably never needed |
| LLM Wiki | Skipped — raw files are readable enough |
| Config system | Skipped — no knobs to tune |
| Soft deletion | Skipped — philosophy says don't delete |
| Multi-device sync | User brings own (git, Dropbox) |
| Project name | Chrollo |
| Language | TypeScript (Pi extension) + Python (future MCP server) |
