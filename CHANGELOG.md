# Changelog

All notable changes to Chrollo are documented here.

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
