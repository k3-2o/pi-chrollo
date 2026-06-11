# Chrollo — Agentic Memory: Design & Architecture

> Design reference for the Chrollo memory system. Covers the core thesis, architecture decisions, integration strategy, and market context.

---

## 1. Background

Chrollo is inspired by the PwC paper *"Is Grep All You Need? How Agent Harnesses Reshape Agentic Search"* ([arXiv:2605.15184](https://arxiv.org/abs/2605.15184), May 2026). The paper demonstrated that in agentic contexts — where an LLM is always in the loop to read, reason, and iterate — grep-based retrieval matches or exceeds vector search across multiple agent harnesses, at near-zero cost.

**Key findings from the paper:**
- Experiment 1: grep beat vector search on every harness-model pair tested. Best result: 93.1% (grep) vs 75.9% (vector) on Codex + GPT-5.4 in inline mode.
- The harness and delivery method matter as much as the retriever itself — changing any one reshuffles results.
- Agentic retrieval is fundamentally different from standalone retrieval benchmarks, because the agent can always search again.

**What the paper did not test:** hybrid search (grep + vector combined), or thesaurus-based query expansion with grep. Both are areas Chrollo explores.

The core insight: if the agent is always in the loop and can iterate, you don't need expensive infrastructure at write time. You just need fast, precise retrieval + a thesaurus for synonyms + an agent that knows how to search again.

---

## 2. Core Thesis

### Axiom

> Don't decide what's important at write time. Store everything verbatim.
> Let the agent figure out relevance at query time.

### Key Insight

Every other memory system was designed for non-agentic retrieval — one-shot, no LLM in the loop. They optimize retrieval benchmark scores. But in agentic systems, the agent is always there. It can read, reason, iterate, and search again. This changes what a retrieval engine needs to do.

### The Approach

```
verbatim storage + grep + thesaurus + recency scoring + agent reads context + agent iterates
     = factual recall solved for the vast majority of cases at near-zero cost
```

No vector embeddings. No LLM compression at write time. No background daemon. No external API dependencies.

---

## 3. Architecture

### Storage Layer

- **Format:** Plain markdown files, one per Pi session
- **Location:** `~/.chrollo/memories/`
- **Content:** Every conversation turn, verbatim + tool call descriptions
- **Frontmatter:** YAML (session_id, date, harness, cwd, parent_session)
- **Write mode:** Append-only, real-time (on every agent_end)
- **File creation:** Deferred until first message with content (empty sessions leave no trace)
- **Deletion policy:** Never delete raw text. Storage is cheap.

### Retrieval Engine

Two layers, executed at query time:

```
Layer 1: ripgrep (exact string match) → ~70% of queries
Layer 2: WordNet thesaurus expansion → ripgrep again → +~20% (cumulative ~90%)
```

Results are ranked by term match count, then recency-boosted:

```
recencyMultiplier = 1 + 1.0 / (daysSince + 1)
finalScore = matchedTermCount × recencyMultiplier(lineDate)
```

Each result includes:
- Full file path (agent can `read` directly)
- ±3 lines of context around each match
- Line numbers on every line (`...(line N)`)
- No header, no branding, no session summary

Results are capped at 10. The agent reads the context, reasons, and can call again with refined terms if needed.

### Thesaurus

- Source: WordNet, processed into a flat JSON synonym map
- Size: 606 words, 3,357 synonym pairs, 46KB
- Zero runtime dependencies — loaded once at startup
- Integration: exact grep → no results → thesaurus expand → grep again

### What's Not Built (And Why)

| Feature | Reason Skipped |
|---|---|
| **BM25 + Inverted Index** | Ripgrep is instant at current scale. |
| **Embedding fallback (all-MiniLM)** | 80MB model for ~1% of queries. Thesaurus + agent iteration covers it. |
| **LLM Wiki layer** | Vanity feature. Raw files are already readable and grep-able. |
| **Config system** | No knobs to tune. Hardcoded constants work fine. |
| **Soft deletion** | Philosophy says "don't decide what's important" — flagging at query time only. |
| **Multi-device sync** | User brings their own (git, rsync, Dropbox). Files are plain markdown. |
| **MCP Server** | Only needed if deploying to non-Pi harnesses. |

---

## 4. Storage Format

### File path
```
~/.chrollo/memories/YYYY-MM-DD_HHMMSS_sessionId.md
```
Format: date + time + first 8 characters of Pi's session UUID.

### Frontmatter
```yaml
---
session_id: "019eb1a9-bc39-7571-b68f-9e5ed2678d73"
date: "2026-06-10"
harness: "pi"
cwd: "/home/k2/.workspaces/chrollo"
parent_session: "/path/to/parent"   # only if resumed/forked
---
```

### Conversation format
```
[YYYY-MM-DD HH:MM:SS] [User]
what project are we working on

[YYYY-MM-DD HH:MM:SS] [Agent]
> read ~/Documents/projects/chrollo/implementation-state.md
> $ ls -la /home/k2/.workspaces/
>
> We're working on **Chrollo** — a persistent memory extension...
```

- Agent responses are blockquoted so internal markdown doesn't clash
- Tool calls are captured chronologically: text → tool calls → text → tool calls
- Two blank lines between turns for readability
- Per-line dates enable correct recency across resumed sessions

### Space estimates

| Scale | Raw text | With inverted index |
|---|---|---|
| 10K turns | ~5MB | ~8MB |
| 100K turns | ~50MB | ~80MB |
| 1M turns | ~500MB | ~800MB |

---

## 5. Key Design Decisions

| Question | Decision | Reasoning |
|---|---|---|
| **Storage format** | Markdown (not JSONL) | Human-readable, grep-able, Obsidian-compatible. JSONL cleaner but loses `cat` readability. |
| **File per** | Session (not day) | Mirrors Pi's session UUID. Sessions can span multiple days. |
| **File creation** | Lazy (on first message, not session start) | Empty sessions leave no trace. |
| **Tool name** | `read_memory` (not `recall_search`) | The `read_` prefix aligns with model training patterns (`read`, `read_image`). |
| **`recall_add` tool** | Removed | Redundant with auto-capture. Every turn is already saved verbatim. |
| **Search engine** | ripgrep (not JS loop) | 100x faster, SIMD-accelerated, scales to 100k files. |
| **Recency** | Per-line timestamps (not file mtime or filename) | Correct recency for resumed sessions. Old format falls back to filename. |
| **Context window** | ±3 lines | Enough for the agent to understand relevance. Agent can expand with `read --offset --limit`. |
| **Brand header** | Removed | The agent knows it called the tool. Extra text is noise. |
| **Tool rendering** | Collapsible `renderCall`/`renderResult` | Ctrl+O toggle. Standard Pi pattern matching `read_image` and `omnisearch_gateway`. |
| **Comment style** | `// --- text ---` | Consistent across all source files. |
| **Code organization** | 6 single-concern modules under `src/` | Separation of concerns after codebase reached ~1,000 lines. |
| **Aborted turns** | Not captured | User re-asks if it mattered. Partial responses are noise. |

---

## 6. Open Questions

| Question | Status |
|---|---|
| **"No matching memories" bug** | Auto-inject found matches but `read_memory` returned nothing. Possibly a tool directory mismatch. Needs investigation. |
| **Provenance — include session_id in search results** | File path encodes it. Explicit field would be cleaner. |
| **Session transition drops last turn** | `/fork` mid-response could clear `lastUserPrompt` before write. Low-severity edge case. |
| **Corrupted file recovery** | If file gets truncated mid-write, no retry mechanism. Hasn't happened in practice. |

---

## 7. Codebase

```
976 lines of TypeScript. 6 modules. Zero runtime dependencies.

chrollo/
├── index.ts           ← Pi extension wiring (225 lines)
└── src/
    ├── capture.ts     ← Turn capture (72 lines)
    ├── format.ts      ← Output formatting (82 lines)
    ├── search.ts      ← Retrieval engine — rg + thesaurus + recency (420 lines)
    ├── stats.ts       ← Memory statistics (30 lines)
    └── storage.ts     ← File I/O (147 lines)
```

### Requirements
- Node.js 20+
- ripgrep (`rg`) — `apt install ripgrep` / `brew install ripgrep`
- Zero npm runtime dependencies

### Thesaurus
- 606 words, 3,357 synonym pairs, 46KB
- Generated once from WordNet via `npm run build-thesaurus`
- Loaded at startup with `JSON.parse` — <1ms, no runtime deps
