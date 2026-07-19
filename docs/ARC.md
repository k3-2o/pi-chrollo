# Architecture & Design

> How Chrollo works, the trade-offs that shaped it, and the iterative process
> that separated what stayed from what didn't.

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

Rare terms (high IDF) outweigh common ones; recent memories (30-day half-life) rank above older ones. today=2.0x, week~1.85x, month=1.5x.

Per-file diversity cap (max 3 from any one session), global cap at 20.

### Lifecycle

Three Pi hooks and one tool:

- **`before_agent_start`** — captures the prompt. Runs a proximity search with a 50ms budget and injects relevant memories as a hidden custom message (`display: false`). Gated: skips trivial prompts (acknowledgements, greetings) and prompts whose distinctive terms haven't changed since the last injection (same search → same results → dedup filters them all).
- **`agent_end`** — builds chronological sections from assistant messages (text → tool calls → text → ...). Appends the turn to the memory file. Creates the file on first write (lazy creation).
- **`session_shutdown`** — clears all state (corpus cache, injected-keys set). No data persists between sessions.
- **`read_memory(query)`** — searches past conversations via single-pass AND + trigram fallback. Returns compact `path:line | text` markers. The agent reads around matches with `read --offset --limit` rather than reading full files.

### Data Flow

From a user's prompt to injected context, the pipeline is:

```
prompt text
  → tokenize() splits identifiers, lowercases, strips punctuation
    → tokenized words
      → extractDistinctiveTerms(words, corpusFreq, totalFiles)
        → derives corpus frequency from the sync module cache
        → scores each word by rarity (lowest freq = most distinctive)
        → drops stop words and >30% frequency terms
        → returns ≤5 most distinctive terms
          → decideAmbientSearch(terms, lastTerms, injectedKeys)
            → isTrivialPrompt() gate (acknowledgements skip)
            → sameTerms() gate (identical terms skip)
            → topicChanged() detection (full break → clear injected set)
          → proximitySearch(terms, 20, signal)
            → rg --json -C with context window
            → JS sliding window: terms within 20 lines of each other?
            → rankResults(results, { idfWeights })
              → buildIdfWeights(terms, freq, totalFiles) for this query
              → dedup by file:line
              → score each: Σ(idf(term)) × recencyMultiplier(lineDate)
              → sort descending, apply per-file cap (3 max/session)
              → return ≤20
            → filterInjected(results, injectedKeys) — skip already-shown
            → formatResultsForContext(topResults)
              → format each as "path:line | text"
              → append "(+N more — use memory intelligently)" if truncated
                → injected into next prompt as hidden message
```

The `read_memory` tool follows the same path, except it calls `grepSearch()` which calls `singlePassAndSearch()` directly (no proximity window) and falls back to `trigramFallback()` on AND-miss.

---

## 3. Design Decisions

| Question              | Decision                             | Reasoning                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storage format**    | Markdown (not JSONL)                 | Human-readable, grep-able, Obsidian-compatible.                                                                                                                                                                                                                                                                                 |
| **File per**          | Session (not day)                    | Mirrors Pi's session UUID. Sessions span multiple days.                                                                                                                                                                                                                                                                         |
| **File creation**     | Lazy (on first message)              | Empty sessions leave no trace.                                                                                                                                                                                                                                                                                                  |
| **Tool name**         | `read_memory` (not `recall_search`)  | `read_` prefix aligns with model training patterns.                                                                                                                                                                                                                                                                             |
| **`recall_add` tool** | Removed                              | Redundant with auto-capture. Violates "don't decide what's important."                                                                                                                                                                                                                                                          |
| **Search engine**     | ripgrep (not JS loop)                | 100× faster, SIMD-accelerated, scales to 100k files.                                                                                                                                                                                                                                                                            |
| **Recency**           | Per-line timestamps (not file mtime) | Correct recency for resumed sessions.                                                                                                                                                                                                                                                                                           |
| **Memory injection**  | Hidden (`display: false`)            | The agent gets context without choosing to look. No preamble telling the agent "these are files on disk" — that would constrain behavioral shaping. No TUI display — that turns ambient recall into a wall of file paths every turn. The agent treats injected context as its own knowledge.                                    |
| **Injection budget**  | 50ms hard timeout, not softer limit  | If injection takes longer than the user's next keystroke, the prompt box freezes. The timeout fires, the search aborts, and the next turn goes uninjected — acceptable because auto-injection is ambient (best-effort). A longer budget would mean more aborts that the user _feels_ rather than ones that silently don't fire. |
| **I/O model**         | Synchronous in handlers              | Pi event handlers must run atomically. Async I/O was tried in 0.2.0 and reverted — see §5.                                                                                                                                                                                                                                      |
| **Corpus cache**      | Module-level, rebuilt per session    | Persisted cache was tried in 0.2.0 and reverted for the same atomicity reason — see §5.                                                                                                                                                                                                                                         |
| **Sidecar files**     | Derived, deletable                   | `.chrollo/metrics.jsonl` is a write-only observability log. Deleting it loses no semantic data — the memory files are the source of truth.                                                                                                                                                                                      |

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
| **`read_memory` "expand" mode**     | The deliberate design is "return compact markers; agent reads around them." An expand mode duplicates the `read` tool's job and muddies the clean abstraction.                                                                                                                                                                                                                                  |
| **Memory toggle / TUI display**     | The toggle means someone forgets they turned it off — agent goes blind, Chrollo feels broken. No preamble telling the agent "this is files on disk, only use if relevant" — that constrains behavioral shaping. TUI display turns ambient recall into a wall of file paths every turn. The fix for injection noise is better retrieval, not a kill switch.                                      |
| **Auto-tag capture**                | Regex-extracting the first identifier into a `#tag` line at write time could improve recall across paraphrase. Held pending understanding the value.                                                                                                                                                                                                                                            |
| **Associative memory links**        | Automatically linking related memories is the frontier. The current approach (grep + agent iteration) already handles most cases. Held until a specific gap appears.                                                                                                                                                                                                                            |

For features that were tried and reverted — see the next section.

---

## 5. How We Got Here: The Iterative Rejection Pattern

Every feature in Chrollo either _stayed_ or was _reverted on evidence_. The pattern is consistent: a plausible hypothesis, implemented, tested with real data, and rejected when the evidence didn't match the theory.

This section documents what was tried, why it seemed like a good idea, and what actually happened.

### Async I/O (Phases 4-5, 0.2.0 — reverted)

**Hypothesis:** Making storage I/O non-blocking would improve responsiveness. The corpus cache write, stats reading, and file appends should be async so they don't block the event loop.

**What was built:** `computeCorpusFrequency()` became async with parallel reads via `fs/promises`. Persisted to `.chrollo/freq.json` with fingerprint by (fileCount, totalBytes) so it was reused across sessions. `initMemoryDir`, `findSessionFile`, `createSessionFile`, `appendLine`, `appendTurn` all switched to `fs/promises`.

**What happened:** The prompt box froze for up to 1.9s on the first prompt of every session. Root cause found by diffing v0.1.12 (which worked) against HEAD: the async conversion destroyed handler atomicity. In v0.1.12, `session_start` warmed the cache _synchronously_ — it was guaranteed ready before the handler returned, so every prompt hit an instant sync read. In the async version, `session_start` fired a fire-and-forget `void computeCorpusFrequency()` and the cache was NOT ready when `before_agent_start` ran. That handler then awaited a ~1.9s rebuild, blocking the prompt box render.

**Lesson:** Pi event handlers must run atomically. If a handler yields (via `await`), there's no guarantee the next handler runs after `await` completes — the runtime is event-driven, not sequential. Sync I/O in handlers that must run atomically is not a bug. The "non-blocking" goal was solving a problem the user didn't have.

**What stayed from 0.2.0:** tokenize() improvements, timezone fix, 30-day recency, distinct-term ranking, per-file diversity cap, single-pass AND, trigram fallback, stemming, injection dedup, metrics. All pure logic — no atomicity risk.

### Thesaurus (Phase 3, 0.2.0 — removed)

**Hypothesis:** Expanding search terms with synonyms catches paraphrase — the user says "fix search" but the memory says "solve retrieval." A WordNet-derived thesaurus would bridge the gap.

**What was built:** A ~5MB WordNet-derived synonym file. `extractDistinctiveTerms` expanded each term into a dozen synonyms via `wordpos`, then grepped for all of them (OR mode). Used from the initial v0.3 through 0.1.12.

**What happened:** WordNet polysemy made the expansion net-negative. `build` expanded to `physique`, `code` to `encipher`, `run` to a dozen irrelevant verb forms. The OR explosion meant a three-term query could become 50+ grep patterns, making search slower _and_ noisier. The extra matches were almost always false positives.

**Removed in:** Phase 3 of the 0.2.0 pass. Replaced by light stemming (Phase 7, same release) which covers morphology without polysemy.

**Lesson:** Synonym expansion via a generic thesaurus is worse than no synonym expansion. The signal-to-noise ratio of WordNet in technical vocabulary is too low. Stemming (which handles the morphological case — `deployment` → `deploy`) was a strict improvement with zero added noise.

### Progressive AND Dropping (0.1.9-0.1.10 — reverted)

**Hypothesis:** When AND search returns nothing, progressively drop the rarest term and retry. This way common+rare term queries still work when the rare term has a typo.

**What was built:** `grepSearch` tried AND with all terms, then dropped the rarest term and retried with N-1, then N-2, down to 1. If nothing matched even with one term, fell back to raw OR.

**What happened:** The progressive dropping made search unpredictable. A five-term query sometimes matched on three terms but the wrong three — returning irrelevant results while the user expected all five terms to matter. The OR fallback at the bottom returned too many results, most irrelevant. The non-determinism made it hard to debug: "I searched for X and Y and got Z which has nothing to do with either."

**Reverted in:** 0.1.10. Kept only the corpus-frequency fallback: if `extractDistinctiveTerms` filters out all terms, fall back to raw query terms (which is deterministic and predictable).

**Lesson:** The agent can always iterate (Axiom 2). If AND returns nothing, the agent changes a search term and tries again. That's better than an automated fallback that returns unpredictable results. The trigram typo fallback (Phase 7) is a principled exception — it only fires when AND-miss is likely a typo (recieve→receive), and its results are deterministic.

### Access-Reinforced Decay (Phase 10B — reverted pre-release)

**Hypothesis:** Memories that the agent _uses_ (reads via `read_memory` or gets injected) should decay slower than memories the agent never touches. An access-reinforced decay would keep frequently-referenced memories fresh.

**What was built:** A sidecar `.chrollo/access.json` tracking when each memory line was last referenced. `recencyMultiplier` blended creation-age decay with access-age decay at 70% strength: `max(creationDecay, 0.7 × accessDecay)`. Wired into `recordAccess()` calls after every search and injection. Cleared at `session_shutdown`.

**What happened:** The 30-day half-life already keeps memories around a long time. The agent can always re-search with different keywords. The feature added a sidecar file (I/O on every search), and a feedback-loop risk: frequently-injected memories self-reinforce and crowd out others across sessions — the same "elegant on paper, no real problem" shape as the async-revert.

**Reverted in:** Same day. Never shipped publicly.

**Lesson:** This is the clearest example of the selection pressure that distinguishes what stays from what doesn't. Phase 10A (injection gating) solved a _measured_ problem — the 50ms budget was blowing on trivial prompts, observable via metrics. Phase 10B (access decay) solved a _theoretical_ problem — memories fading too fast — that nobody had reported and that the existing 30-day half-life already covered. 10A solved a real problem at near-zero cost. 10B added complexity, I/O, and risk for a hypothetical benefit.

### The Selection Pressure

```
Did it solve a measured problem? → stays (10A gating, 10C IDF weighting)
Did it solve a theoretical problem? → reverted (async I/O, thesaurus, 10B access decay)
```

Not every good idea is a good fit for this project. The three features that stayed (10A gating, 10C IDF weighting, and the Phase 1-7 correctness improvements) all had concrete evidence that they addressed real issues. The features that were reverted all started from plausible theories that didn't hold up in practice.
