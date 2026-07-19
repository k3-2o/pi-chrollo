# Audit Findings — chrollo

**Baseline**: `44426d1` — tests: 140 passed, 0 failed  
**Status**: Phase 1 complete; 2 findings refined, pending remediation (F-02 high, F-01 medium)  
**Orientation**: 32 files inventoried, 50+ cross-file connections mapped

---

## Phase 0 — Orientation Inventory

### File inventory

**Entry / lifecycle**
- `index.ts` — Pi extension entry point; registers `session_start`, `session_shutdown`, `before_agent_start`, `user_turn`, `agent_turn`, and `read_memory` tool.
- `vitest.config.ts` — test runner configuration.
- `justfile` — dev tasks (check, test, fmt, ci).
- `package.json` — package metadata and scripts.
- `tsconfig.json` — TypeScript compiler options.
- `.prettierrc.json` — formatting rules.
- `.gitignore` / `.npmignore` — distribution and ignore rules.

**Documentation**
- `README.md` — user-facing feature overview.
- `CHANGELOG.md` — version history and design decisions.
- `docs/ARC.md` — architecture and reasoning.
- `IMPORT.md` — import / migration instructions.

**Source code (`src/`)**
- `src/access.ts` — access-reinforced decay sidecar; read/write `.chrollo/access.json`.
- `src/capture.ts` — turn content extraction and tool-call formatting helpers.
- `src/format.ts` — render search results and tool calls into context strings.
- `src/inject.ts` — injection gating logic (trivial prompts, term change, dedup).
- `src/metrics.ts` — `.chrollo/metrics.jsonl` recording and reading.
- `src/search.ts` — search core: tokenization, stemming, corpus frequency, AND search, proximity search, ranking, IDF weights.
- `src/stats.ts` — memory collection statistics.
- `src/storage.ts` — filesystem I/O for memory markdown files and sessions.

**Tests (`test/`)**
- `test/access.test.ts` — access sidecar behavior.
- `test/capture.test.ts` — turn extraction and tool call formatting.
- `test/corpus-cache.test.ts` — corpus frequency cache.
- `test/dates.test.ts` — date parsing from filenames and lines.
- `test/idf.test.ts` — IDF weight computation and ranking.
- `test/inject.test.ts` — dedup, gating, term comparison.
- `test/metrics.test.ts` — metrics sidecar recording/reading.
- `test/rankResults.test.ts` — result ranking, dedup, per-file cap.
- `test/recency.test.ts` — recency multiplier math.
- `test/sanity.test.ts` — smoke test for package import.
- `test/search-and.test.ts` — single-pass AND search and grepSearch.
- `test/stemming-trigram.test.ts` — stemming and trigram fallback.
- `test/storage.test.ts` — memory file CRUD and path resolution.
- `test/tokenize.test.ts` — tokenization rules.

**Scripts**
- `scripts/import-pi-sessions.sh` — shell helper to import existing Pi sessions into memories.
- `package-lock.json` — dependency lockfile.

### Cross-file connections

**`index.ts` orchestrates all src modules:**
- `index.ts` → `src/storage.js` — resolves memories dir, writes turns/sessions.
- `index.ts` → `src/capture.js` — extracts text from turns; formats tool calls.
- `index.ts` → `src/stats.js` — exposes stats via `memory_stats` tool.
- `index.ts` → `src/inject.js` — gating and dedup for auto-injection.
- `index.ts` → `src/search.js` — proximity search for auto-injection; `read_memory` tool.
- `index.ts` → `src/format.js` — renders search results / tool calls for context.
- `index.ts` → `src/metrics.js` — records search/inject metrics.
- `index.ts` → `src/access.js` — invalidates access cache on shutdown.

**`src/search.ts` is the central hub:**
- imports `getMemoriesDir` from `src/storage.js` (filesystem root).
- imports `recordMetric` from `src/metrics.js` (observability).
- imports `getAccessMap`, `recordAccess` from `src/access.js` (Phase 10B).
- exports `tokenize`, `stem`, `groupWithStem`, `trigramRegex`, `parseFileDate`, `parseLineDate`, `recencyMultiplier`, `computeCorpusFrequency`, `extractDistinctiveTerms`, `singlePassAndSearch`, `grepSearch`, `proximitySearch`, `rankResults`, `buildIdfWeights`, `SearchResponse`, `CompactResult`.
- called by `index.ts`, `src/format.js`, and most test files.

**`src/access.ts` is a sidecar cache:**
- imports `getMemoriesDir` from `src/storage.js` to locate `.chrollo/access.json`.
- consumed by `src/search.js` (ranking + recording) and `index.ts` (shutdown invalidation).

**`src/metrics.ts` is a sidecar:**
- imports `getMemoriesDir` from `src/storage.js` to locate `.chrollo/metrics.jsonl`.
- consumed by `src/search.js` (records every search/inject) and `index.ts`.

**`src/storage.ts` is the ground truth for paths:**
- resolves project-level or global memories dir via `getMemoriesDir` / `setActiveMemoriesDir`.
- used by `src/access.js`, `src/metrics.js`, `src/stats.js`, `src/search.js`, `index.ts`, and many tests.

**`src/format.ts` renders search output:**
- imports `SearchResponse` from `src/search.js`.
- consumed by `index.ts` for context injection and tool response rendering.

**`src/inject.ts` is stateless helper logic:**
- used by `index.ts` for gating and dedup; no filesystem I/O.

**`src/stats.ts` is read-only:**
- imports `getMemoriesDir` from `src/storage.js`.
- called by `index.ts` for the `memory_stats` tool.

**`src/capture.ts` is stateless helper logic:**
- used by `index.ts` to extract text from turns and format tool calls.

### Filesystem and I/O boundaries

- **Memory files**: `storage.ts` writes to `<memoriesDir>/memories/*.md`.
- **Metrics sidecar**: `metrics.ts` appends to `<memoriesDir>/metrics.jsonl`.
- **Access sidecar**: `access.ts` writes `<memoriesDir>/access.json`.
- **External tools**: `search.ts` spawns `rg` (ripgrep) via `execFile`.
- **No network I/O.**
- **No async I/O in handlers** (post-revert design): all handler-side filesystem operations are synchronous.

---

## Phase 1 — Findings

### 🟡 F-01 — 50ms injection timer does not enforce the budget for post-search work

- **Source**: Leg 1 (adversarial)
- **File**: `index.ts:188-220` (inside `before_agent_start` handler)
- **Status**: `pending`
- **What**: The `AbortController` timer is set to fire at 50ms and is passed to `proximitySearch`. `proximitySearch` observes the signal while `rg` is running, so the search itself is bounded. However, once `await proximitySearch(...)` returns, the code continues with `formatResultsForContext`, `recordInjected`, and returning the injected message. The pending timer is only cleared in the `finally` block. If `proximitySearch` returns just before the 50ms mark, the timer can fire during the subsequent synchronous work, but the abort signal is no longer observed, so the work continues. The stated 50ms budget is not enforced for the full injection path.
- **Why it survived self-critique**: The `finally` block does clear the timer, but only after the post-search work completes. The code never re-checks `controller.signal.aborted` after the `await`. The `catch` block is also only reached if `proximitySearch` throws; `proximitySearch` catches its own `rg` aborts and returns a response, so the outer `catch` almost never runs.
- **Exploitation path**: A prompt where `proximitySearch` returns at ~49ms but `formatResultsForContext` + `recordInjected` + response construction takes >2ms results in total injection latency >50ms. The prompt box may still freeze slightly beyond the documented budget, and the metric (recorded by `proximitySearch`'s internal `track`) will show ~50ms even though the actual handler took longer.
- **Refinement answers**:
  1. **Line number real?** Yes — `index.ts:188-220` contains the timer, the `await`, and the post-search work.
  2. **Type what I claimed?** Yes — `setTimeout` returns `NodeJS.Timeout`; `controller.signal` is `AbortSignal`; `proximitySearch` returns `Promise<SearchResponse>`.
  3. **Precondition holds?** Yes — the timer fires at 50ms; if the `await` resolves at 49ms and the sync work takes 2ms, the timer fires during the sync work before `finally` clears it.
  4. **Test/behavior verified?** The behavior is observable from the code path; no existing test covers it. A test can be written that mocks `proximitySearch` to resolve just before the budget and asserts the handler checks `signal.aborted` afterwards.
- **Fix direction**: Clear the timer immediately after the `await` resolves, and check `controller.signal.aborted` before doing post-search work. This bounds the whole injection path to the 50ms budget.

### 🔴 F-02 — `sameTerms` check in `before_agent_start` is always true, causing all same-topic follow-ups to skip injection

- **Source**: Leg 1 (adversarial)
- **File**: `index.ts:191-193` (`lastDistinctTerms = currentTerms` before `sameTerms`)
- **Status**: `pending`
- **What**: The code updates `lastDistinctTerms = currentTerms` **before** evaluating `sameTerms(lastDistinctTerms, currentTerms)`. Since `sameTerms` compares a set to itself, it always returns `true`. Therefore, the condition `injectedKeys.size > 0 && sameTerms(...)` reduces to `injectedKeys.size > 0`. After the first successful injection on a topic, every subsequent prompt with `distinctTerms.length >= 2` on the same topic is skipped, even if the distinctive terms changed and would produce different results.
- **Why it survived self-critique**: The comment says "If even one term changed (a new sub-question on the same topic), re-search," but the code does not implement that. The update of `lastDistinctTerms` before the comparison makes the comparison trivially true.
- **Exploitation path**:
  1. Turn 1: user asks "chrollo search fix". `distinctTerms` = [chrollo, search, fix]. `topicChanged` is false (no prior topic). `lastDistinctTerms` = [chrollo, search, fix]. Search runs, results injected, `injectedKeys` populated.
  2. Turn 2: user asks "chrollo search ranking". `distinctTerms` = [chrollo, search, ranking]. `topicChanged` returns false (overlap with [chrollo, search, fix]). `injectedKeys` is **not** reset. `lastDistinctTerms` is updated to [chrollo, search, ranking]. `sameTerms([chrollo, search, ranking], [chrollo, search, ranking])` returns true. `injectedKeys.size > 0` is true. Handler returns early. The new query, which would likely surface different results focused on "ranking", is never run. The agent loses relevant context for the follow-up.
- **Refinement answers**:
  1. **Line number real?** Yes — `index.ts:191` assigns `lastDistinctTerms = currentTerms`; `index.ts:193` calls `sameTerms(lastDistinctTerms, currentTerms)`.
  2. **Type what I claimed?** Yes — both are `Set<string>`, `sameTerms` compares size and membership.
  3. **Precondition holds?** Yes — a follow-up prompt on the same topic with a different sub-question (different distinctive terms) is a common user behavior.
  4. **Test/behavior verified?** No existing test covers the integration of `topicChanged` + `sameTerms` in `index.ts`. The bug is visible from the code path. A test can be written by extracting the logic into a testable pure function or by mocking `proximitySearch` and observing it is not called for the second prompt.
- **Fix direction**: Move `lastDistinctTerms = currentTerms` to **after** the `sameTerms` check, so the comparison uses the previous prompt's terms against the current prompt's terms. Alternatively, compare `sameTerms(previousLastDistinctTerms, currentTerms)` before updating.

---

## Phase 3 — Completion Accounting

*(To be reconciled after remediation.)*
