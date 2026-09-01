## [0.4.2] - 2026-09

**Prompt surface rewrite.** Tool descriptions, snippets, and guidelines rebuilt in the
session-memory register — plain sentences, concrete triggers, no ceremony. ~1900 → 1284 chars.

### Changed
- search_memory: description 1081 → 393 chars; query mechanics moved to one sentence + the param description; examples collapsed to a single inline `Ex:`.
- read_memory: description 530 → 244 chars; the `Parameters:` prose block deleted (TypeBox schema already carries each param).
- Dropped the stale "BM25-ranked" claim (engine is term-overlap + recency tie-break since 0.4.0).
- Deduplicated: follow-up-with-read_memory lives once (search guidelines), no longer three times across both tools.
## [0.4.1] - 2026-09

**Bridge-eligible.** Both tools are now factory exports — the "exportable ⇒ declarable"
standard, same as pi-read-image.

### Added
- `createSearchMemoryTool()` / `createReadMemoryTool()` factory exports owning the full tool
  objects (description, parameters, execute, renderers). The default extension is now just
  two `registerTool` calls.

### Fixed
- Packaging: `@earendil-works/pi-tui` moved from devDependencies to **dependencies** — `Text`
  is a runtime import, and the npm store copy had no `node_modules` (it only resolved via a
  hoisted accidental from another package). `pi-coding-agent` stays dev-only: chrollo's use
  is `import type` exclusively, erased at load time.

## [0.4.0] - 2026-08

**Search engine flattened.** Rebuilt the retrieval path from eight scoring/scoping modules
into a single ripgrep call + a lightweight rank overlay. Deleted the BM25 scorer, the
recency-decay/cwd/diversity orchestrator, stemming, the trigram typo fallback, and the
SIGTERM salvage layer. ripgrep now searches and recency-orders in one pass.

### Added
- Term-overlap ranking: a line matching more distinct query keywords ranks above a recent line matching fewer. Recency is the tie-break.
- Real cancellation: Esc/abort is wired into the rg child; a cancelled scan returns `aborted`, never a fake miss.

### Changed
- rg per-file match cap raised to 200 so a real answer buried mid-session is reachable before ranking.
- Recency via `--sortr modified` (most-recent sessions first) instead of 30-day half-life decay on per-line timestamps.
- Search is stateless across calls — no corpus cache, no global term-frequency dictionary.
- Honest timeout: a stalled scan says "search timed out — retry", never "No memories found".

### Removed
- `src/rank.ts`, `src/score.ts`, stemming/`groupWithStem`, the trigram typo fallback, the adapter-seam taxonomy, per-file cwd reads.
- The 13s-freeze class of global-corpus-stat scanning entirely.

### Fixed
- A timed-out scan could previously be reported as an empty store; that can no longer happen.

# Changelog

All notable changes to Chrollo are documented here.

## [0.3.3] — 2026-08

**Cold-start fix.** First-time searches after a PC boot used to return
"No memories found" for queries that obviously existed: ripgrep needed ~8s+ to
scan the ~200MB session store from a cold spinning disk, and the `RG_TIMEOUT_MS
= 5000` kill switch SIGTERM'd it mid-scan — the `catch` then reported the kill
as a genuine no-match. Repeated attempts slowly warmed the OS page cache,
making it look like chrollo needed 3–5 tries to "wake up".

### Fixed

- **A timeout is never reported as a miss.** The search_memory tool now wires
  its abort signal into the rg child (`execFile` `signal` option), so Esc/
  cancel genuinely kills the scan immediately — no orphaned rg grinding the
  disk in the background. The timeout is demoted to a 30s pure backstop (was
  5s) that only fires on a genuinely stalled/huge scan, never on a legitimate
  cold-disk scan. When the backstop does fire, its partial stdout is salvaged
  (`rgCatch`) and returned as real first-attempt results; only if nothing was
  ready does the tool say "search timed out — retry" instead of the misleading
  "No memories found". Same treatment applied to the trigram typo fallback, which
  had the identical 5s kill switch.
- **A cancelled search is a cancellation, not an error.** Abort during a scan
  returns cleanly (the tool reports `aborted`); it can no longer be mistaken
  for a timeout or a miss.

## [0.3.2] — 2026-07

**Adversarial-audit remediation.** Security hardening and dead-code
cleanup on the 0.3.1 retrieval layer.

### Fixed

- **Path traversal / containment bypass via symlink in `read_memory`** —
  `isSessionPath` validated paths with `path.resolve`, which normalizes
  `.`/`..` but does **not** resolve symbolic links. Because
  `fs.readFileSync` follows symlinks, a path under the session root that
  was a symlink to a file outside the root passed validation and could
  be rendered as a session memory. The containment check now resolves
  both the target path and the session root with `fs.realpathSync`
  (falling back to `path.resolve` when realpath fails) before comparing
  them. A regression test guards the symlink case.

### Removed

- **Dead dedup utilities in `rank.ts`** — `dedupKey`, `filterInjected`,
  and `recordInjected` were ported from the old auto-injection
  architecture but were never wired into the 0.3.0 read-only pipeline.
  They were only exercised by tests. Deleted from `src/rank.ts` along
  with their dedicated test block.

---

## [0.3.1] — 2026-07

**Polish pass on the retrieval layer.** No architecture change — same
read-only, two-tool design as 0.3.0. This release closes the residual UX
and recall-quality gaps surfaced by dogfooding `search_memory` in real
sessions.

### Fixed

- **TUI stutter on common-term searches** — `buildSearchResults` was
  synchronous, so a search returning thousands of ripgrep hits blocked
  the event loop for the full parse/rank pass (~1s) and the input box /
  message bubble stuttered. The parse loop now `await`s a `setImmediate`
  yield every 200 matches (`PARSE_CHUNK`), letting the render thread
  paint between batches. The 0.3.0 post-mortem flagged this as the
  residual lag left after the 13s corpus scan was removed; it is now
  actually applied.
- **Startup banner** — the `session_start` `ui.notify(`"`Chrollo: retrieval
  layer ready (search_memory + read_memory)`"`)` popup is removed. It fired
  on every launch and stated a readiness the tool had not earned.

### Changed

- **`RG_MAX_COUNT_PER_FILE`: 20 → 5.** Diversity capping keeps at most
  3 results per file, so 20 rg hits per file was pure waste — parsed and
  scored only to be discarded. 5 gives 2 spares for intra-file ranking.
  Measured **2–3× faster** steady-state search (1.5–2.3s → 0.4–1.4s over
  the live 267-session corpus) with no recall loss.
- **Strengthened tool prompts.** Both tools now carry 3 `promptGuidelines`
  instead of 1–2. `search_memory` teaches the model to (a) reach for it
  *first* on any project resume or past-work reference, not just explicit
  "remember when" prompts; (b) use 2–4 distinctive terms — terms are
  OR-matched, so common words only widen the net. `read_memory` teaches
  that the one-line preview is rarely enough and the window read is
  almost always worth the call. The OR-semantics note moved into the
  `description` so the model stops assuming AND.

### Added

- **Current-session exclusion.** `search_memory` now passes
  `excludePath = ctx.sessionManager.getSessionFile()` so the agent's own
  live session file is dropped from results. Without this, every search
  returned the current session as the top hit (max recency + all query
  terms present), crowding out older, actually-useful sessions. The agent
  already has that context in its window.

### Removed

- **Stale install `test/` directory.** The live install at
  `~/.pi/agent/extensions/chrollo/test/` still held 13 old-architecture
  test files (`capture.test.ts`, `idf.test.ts`, `inject.test.ts`,
  `metrics.test.ts`, `corpus-cache.test.ts`, `storage.test.ts`, …) that
  referenced modules deleted in 0.3.0. Replaced with the current 9-file
  suite so the install is self-consistent.

---

## [0.3.0] — 2026-07

**Architecture pivot.** Chrollo is no longer a capture-and-inject memory
system. It is now a read-only retrieval layer over Pi's native session
files. The capture pipeline, auto-injection, and own storage are all gone.

### Removed

- **Capture pipeline** — Chrollo no longer writes `.chrollo/memories/`.
  Pi's native `.jsonl` sessions are the sole source of truth.
- **Auto-injection** — the `before_agent_start` injection path is deleted
  entirely. It had a ~4.4% effective success rate (90% of attempts aborted
  within the 50ms budget; most survivors found nothing). Recall is now
  explicit: the agent calls `search_memory` when you reference past work.
- **Own storage / metrics** — `storage.ts`, `metrics.ts`, `inject.ts`,
  `capture.ts`, and the entire markdown capture era are removed.
- **Corpus stats scan** — the per-search term-frequency dictionary (BM25's
  IDF/rare-term weighting) is permanently removed. It scanned every line of
  every session (~13s over 267 files) and froze the UI on every search. See
  `Fixed` below and the project SPEC for the full rationale.

### Added

- **`search_memory` tool** — keyword search across all of Pi's session
  history. Returns `path:line | role: preview` markers, ranked by term
  match (saturation + length normalization), 30-day recency, and a
  same-project boost.
- **`read_memory` tool** — read a bounded window of a session file,
  rendered readably. `offset` is required (no whole-file reads); `limit`
  capped at 50.
- **Structural filtering** — reads Pi's JSONL line types and drops tool
  outputs, internal reasoning, and metadata automatically. Only real
  conversation turns appear in results and reads.
- **Trigram typo fallback** — when an exact search returns nothing, retries
  once with 3-char sub-patterns.
- **Multi-harness seam** — a single `parseLine(path, raw)` dispatch point
  so future harnesses (Claude Code, Codex) can be added as adapters without
  touching the core.

### Changed

- **Engine** — ripgrep for bulk retrieval, native `JSON.parse` for
  structure, TF-saturation for scoring. No LLM, no embeddings, no index,
  no daemon. One binary dependency (ripgrep).

### Fixed

- **Search freeze** — the corpus-stats scan froze Pi's UI for ~13s on
  every search (and re-ran whenever Pi wrote a turn). Removed permanently.
  Steady-state search is now sub-2s.

### Migration from 0.2.0

0.3.0 is incompatible with 0.2.0 at every level. Existing `.chrollo/`
  directories are simply ignored — safe to delete. There is no data to
  migrate: the tool now reads Pi's native sessions directly, so all your
  history (including pre-Chrollo sessions) is already covered.

---

## [0.2.0] — 2026-07

A correctness / recall / reliability pass driven by a full adversarial audit.
A full test pipeline was added; `just ci` (fmt + types + smoke + test) green.
No information lost — all memory files remain the sole source of truth;
`metrics.jsonl` is a derived cache (deletable).

> **Historical note:** 0.2.0 was the final release of the capture-and-inject
> architecture. The auto-injection feature it documents never worked reliably
> and was removed in 0.3.0. The entries below describe 0.2.0 as it shipped.

### Correctness

- **Timezone fix (AD-1)** — timestamps were written local but read as UTC;
  today's memories now get their full recency boost.
- **30-day recency half-life (AD-5)** — replaces the inverse curve that decayed
  too fast (~7-day effective); "last month" signal now survives.
- **Distinct-term ranking (AD-14)** — a word matched 3× no longer triples a
  line's score; distinct terms are counted.
- **Corpus cache invalidation (AD-2)** — the module-level frequency cache is
  cleared at session_shutdown and rebuilt fresh (synchronously) at the next
  session_start, so it no longer goes stale across sessions.

### Recall

- **Code-aware tokenizer (AD-6)** — splits camelCase / snake_case / kebab-case;
  `optimizeRerenders` is now findable as "optimize".
- **Light stemming (AD-11)** — `deployment` finds `deploy`; `running` finds
  `run`. Pure string ops, no model.
- **Trigram typo fallback (AD-12)** — last resort on AND-miss surfaces
  `receive` when you type `recieve`.

### Performance / reliability

- **Single-pass AND search (AD-4)** — one `rg --json` call replaces N serial
  ripgrep processes (file-level AND computed in JS).

> **Note on reverted work (AD-8, AD-6 cache):** 0.2.0 originally shipped an
> async-I/O conversion (AD-8, `fs/promises` throughout) and a persisted
> corpus cache. Both were reverted before release — the async conversion
> destroyed the atomicity the Pi event handlers rely on. The pure-logic
> improvements were kept.

### Quality

- **Per-file diversity cap (AD-9)** — max 3 results per session file.
- **Injection dedup (AD-10)** — follow-up turns skip already-injected lines;
  resets on topic change.

### Observability

- **Metrics sidecar (AD-13)** — `.chrollo/metrics.jsonl` records every
  search/inject (latency, result count, abort). `just clean-metrics` truncates.

### Removed

- **Thesaurus (AD-7)** — WordNet polysemy made it net-negative;
  stemming + agent iteration cover the morphological cases.
- **`fuzzySearch` (AD-3)** — ~60 lines of dead code; removed.

### Engineering

- Real test pipeline: `justfile` (fmt/lint/check/types/test/ci), `tsconfig.json`,
  `vitest`. Host type packages declared as devDeps so `tsc` resolves standalone.

---

## [0.1.12] — 2026-06

Last pre-audit release of the capture-and-inject architecture.
