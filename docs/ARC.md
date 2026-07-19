# Architecture & Design

> How Chrollo works, the trade-offs that shaped it, and what's deliberately not built.

---

## 1. Thesis

### Axiom

> Don't decide what's important at write time. Store everything verbatim.
> Let the agent figure out relevance at query time.

### Key Insight

Every other memory system was designed for non-agentic retrieval — one-shot, no LLM in the loop. They optimize benchmark scores. But in agentic systems, the agent is always there. It can read, reason, iterate, and search again. This changes what a retrieval engine needs to do.

The PwC paper _"Is Grep All You Need?"_ ([arXiv:2605.15184](https://arxiv.org/abs/2605.15184), May 2026) validated this: in agentic contexts, grep-based retrieval matches or exceeds vector search at near-zero cost because the agent iterates. Chrollo pushes further — no vectors, no BM25, no embeddings. Just ripgrep + light stemming + an agent that knows how to think.

### Approach

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

Term extraction splits camelCase / snake_case / kebab-case identifiers (so `optimizeRerenders` is searchable as "optimize") and applies light stemming (`deployment` → `deploy`; ripgrep `-F` substring-matching then catches every inflection at once). A corpus-frequency filter drops words appearing in >30% of files. The frequency index is a **synchronous module-level cache**, built once at `session_start` (~280ms) and reused for every prompt that session; cleared at `session_shutdown` so the next session rebuilds fresh.

Results ranked by IDF-weighted matched terms, then recency-boosted:

```
recencyMultiplier = 1 + exp(-daysSince / 43)
finalScore = Σ(idf(term)) × recencyMultiplier(lineDate)
```

Rare terms (high IDF) outweigh common ones; recent memories (30-day half-life) rank above older ones.

Per-file diversity cap (max 3 from any one session), global cap at 20.

### Lifecycle

Three Pi hooks and one tool:

- **`before_agent_start`** — captures the prompt. Runs a proximity search with a 50ms budget and injects relevant memories as a hidden custom message (`display: false`). Gated: skips trivial prompts (acknowledgements, greetings) and prompts whose distinctive terms haven't changed since the last injection (same search → same results → dedup filters them all).
- **`agent_end`** — builds chronological sections from assistant messages (text → tool calls → text → ...). Appends the turn to the memory file. Creates the file on first write (lazy creation).
- **`session_shutdown`** — clears all state (corpus cache, injected-keys set). No data persists between sessions.
- **`read_memory(query)`** — searches past conversations via single-pass AND + trigram fallback. Returns compact `path:line | text` markers. The agent reads around matches with `read --offset --limit` rather than reading full files.

---

## 3. Design Decisions

| Question              | Decision                             | Reasoning                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storage format**    | Markdown (not JSONL)                 | Human-readable, grep-able, Obsidian-compatible.                                                                                                                                                                                                                                                      |
| **File per**          | Session (not day)                    | Mirrors Pi's session UUID. Sessions span multiple days.                                                                                                                                                                                                                                              |
| **File creation**     | Lazy (on first message)              | Empty sessions leave no trace.                                                                                                                                                                                                                                                                       |
| **Tool name**         | `read_memory` (not `recall_search`)  | `read_` prefix aligns with model training patterns.                                                                                                                                                                                                                                                  |
| **`recall_add` tool** | Removed                              | Redundant with auto-capture. Violates "don't decide what's important."                                                                                                                                                                                                                               |
| **Search engine**     | ripgrep (not JS loop)                | 100× faster, SIMD-accelerated, scales to 100k files.                                                                                                                                                                                                                                                 |
| **Recency**           | Per-line timestamps (not file mtime) | Correct recency for resumed sessions.                                                                                                                                                                                                                                                                |
| **Memory injection**  | Hidden (`display: false`)            | The agent gets context without choosing to look. No preamble telling the agent "these are files on disk" — that would constrain behavioral shaping. No TUI display — that turns ambient recall into a wall of file paths every turn. The agent treats injected context as its own knowledge.         |
| **I/O model**         | Synchronous (not async)              | Pi event handlers must run atomically. Async I/O destroyed atomicity in 0.2.0 — `session_start` couldn't guarantee the corpus cache was warm before returning, so `before_agent_start` awaited a ~1.9s rebuild and froze the prompt box. Sync I/O in handlers that must run atomically is not a bug. |
| **Synchronous cache** | Module-level (not persisted to disk) | Persisted corpus cache (`.chrollo/freq.json`) was reverted for the same atomicity reason. The module cache is rebuilt once per session (~280ms at `session_start`).                                                                                                                                  |
| **Sidecar files**     | Derived, deletable file              | `.chrollo/metrics.jsonl` (latency/abort log) is a write-only cache. Deleting it loses no semantic data — the memory files are the source of truth.                                                                                                                                                    |

### Search result format

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

---

## 4. What's Not Built (And Why)

| Feature                             | Reason                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BM25 + inverted index**           | Ripgrep is instant at current scale. Even at 100k+ lines, ripgrep keeps up.                                                                                                                                                                                                                                                                                                                     |
| **Embedding fallback (all-MiniLM)** | 80MB model for ~1% of queries. Stemming + trigram + agent iteration covers it.                                                                                                                                                                                                                                                                                                                  |
| **Config system**                   | No knobs to tune. Hardcoded constants work fine.                                                                                                                                                                                                                                                                                                                                                |
| **Soft deletion**                   | Storage is cheap. Don't delete.                                                                                                                                                                                                                                                                                                                                                                 |
| **Multi-device sync**               | User brings their own (git, rsync, Dropbox). Files are plain markdown.                                                                                                                                                                                                                                                                                                                          |
| **MCP Server**                      | Only needed for non-Pi harnesses (Claude Code, Codex). Not yet.                                                                                                                                                                                                                                                                                                                                 |
| **LLM Wiki**                        | Karpathy's pattern works for documents — feed it an article, it writes wiki pages, you query the index. For conversation memory, the agent would have to constantly write wiki pages about what was said. This loses the raw text (phrasing, emotion, nuance) and adds an LLM call on every turn. The answer to "but structured facts" is: keep your keywords clean and the agent will find it. |
| **Thesaurus**                       | WordNet polysemy made it net-negative (`build`→`physique`, `code`→`encipher`). Stemming covers morphology; the agent iterates for true synonyms. Only revival path: a hand-curated dev/tech synonym map, and only if synonym-recall failures are demonstrated after stemming ships.                                                                                                             |
| **`read_memory` "expand" mode**     | The deliberate design is "return compact markers; agent reads around them." An expand mode duplicates the `read` tool's job and muddies the clean abstraction.                                                                                                                                                                                                                                  |
| **Memory toggle / TUI display**     | The toggle means someone forgets they turned it off — agent goes blind, Chrollo feels broken. No preamble telling the agent "this is files on disk, only use if relevant" — that constrains behavioral shaping. TUI display turns ambient recall into a wall of file paths every turn. The fix for injection noise is better retrieval, not a kill switch.                                      |
| **Auto-tag capture**                | Regex-extracting the first identifier into a `#tag` line at write time could improve recall across paraphrase. Held pending understanding the value.                                                                                                                                                                                                                                            |
| **Associative memory links**        | Automatically linking related memories is the frontier. The current approach (grep + agent iteration) already handles most cases. Held until a specific gap appears.                                                                                                                                                                                                                            |
