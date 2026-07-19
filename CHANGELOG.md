# Changelog

All notable changes to Chrollo are documented here. Versions follow the
experiments-shipped convention of the existing git tags.

## [0.2.0] — 2026-07

A correctness / recall / reliability pass driven by a full adversarial audit.
109 tests added; `just ci` (fmt + types + smoke + test) green. No information
lost — all memory files remain the sole source of truth; `freq.json` and
`metrics.jsonl` are derived caches.

### Correctness
- **Timezone fix (AD-1)** — timestamps were written local but read as UTC;
  today's memories now get their full recency boost.
- **30-day recency half-life (AD-5)** — replaces the inverse curve that decayed
  too fast (~7-day effective); "last month" signal now survives.
- **Distinct-term ranking (AD-14)** — a word matched 3× no longer triples a
  line's score; distinct terms are counted.
- **Corpus cache invalidation (AD-2)** — the frequency cache is now rebuilt at
  session start + after each write, no longer stale across sessions.

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
- **Async I/O (AD-8)** — `fs/promises` throughout; the hot `agent_end` write
  path no longer blocks the event loop.
- **Persisted corpus cache (AD-6)** — `.chrollo/freq.json` (fingerprinted);
  cold session-start dropped from ~1.9s to ~95ms.

### Quality
- **Per-file diversity cap (AD-9)** — max 3 results per session file.
- **Injection dedup (AD-10)** — follow-up turns skip already-injected lines;
  resets on topic change.

### Observability
- **Metrics sidecar (AD-13)** — `.chrollo/metrics.jsonl` records every
  search/inject (latency, result count, abort). `just clean-metrics` truncates.

### Removed
- **Thesaurus (AD-7)** — WordNet polysemy made it net-negative
  (`build`→`physique`, `code`→`encipher`); stemming + agent iteration cover
  the morphological cases.
- **`fuzzySearch` (AD-3)** — ~60 lines of dead code; removed.

### Engineering
- Real test pipeline: `justfile` (fmt/lint/check/types/test/ci), `tsconfig.json`,
  `vitest`. Host type packages declared as devDeps so `tsc` resolves standalone.

### Known limitation (flagged, not changed in 0.2.0)
Metrics exposed that `proximitySearch` (the auto-injection path) takes ~200ms on
a ~285-file corpus — over its 50ms budget, so injection is currently aborting.
The budget (`INJECT_BUDGET_MS`) is a tuning constant; raising it trades a little
rendering latency for actual recall. See `docs/ARC.md`.

### Held / rejected (see SPEC §10)
- Reconnect double-append fix — held pending walkthrough.
- Auto-tag capture — held pending understanding the value.
- `read_memory` "expand" mode — rejected by design.

---

## [0.1.12] — 2026-06

Last pre-audit release.
