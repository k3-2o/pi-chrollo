# Changelog

All notable changes to Chrollo are documented here. Versions follow the
experiments-shipped convention of the existing git tags.

## [0.2.0] — 2026-07

A correctness / recall / reliability pass driven by a full adversarial audit.
A full test pipeline was added; `just ci` (fmt + types + smoke + test) green.
No information lost — all memory files remain the sole source of truth;
`metrics.jsonl` is a derived cache (deletable).

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
> corpus cache (`.chrollo/freq.json`, fingerprinted, 1.9s→95ms cold start).
> **Both were reverted before release.** The async conversion destroyed the
> atomicity the Pi event handlers rely on: `session_start` could no longer
> guarantee the corpus cache was warm before it returned, so `before_agent_start`
> ended up `await`ing a ~1.9s rebuild and froze the prompt box on the first
> prompt of every session. Sync I/O in handlers that must run atomically is
> not a bug — the "non-blocking" goal solved a problem the tool didn't have.
> The pure-logic improvements (single-pass AND, tokenizer, etc.) were kept.
> See `docs/ARC.md` for the full write-up.

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

## [Unreleased] — Smart Retrieval (Phase 10)

Post-0.2.0 optimizations from the frontier-memory research synthesis. All stay
in-paradigm: no LLM calls, no embeddings, no extraction. 133 tests green.

### Proactive injection (10A)

- **Trivial-prompt gating** — `isTrivialPrompt()` skips the proximity search for
  acknowledgements, greetings, thanks, and continuations. One real word in the
  prompt → not trivial → search proceeds.
- **Identical-term skip** — `sameTerms()` skips the search when the distinctive
  terms haven't changed since the last injection (same terms → same results →
  dedup would filter them all). A single new term re-triggers.
- Directly addresses the 50ms-budget aborts documented in ARC.

### IDF-weighted ranking (10C)

- **`buildIdfWeights`** — `log(1 + totalFiles / (1 + freq))` per matched term.
  Rare terms (`k3s`) outweigh common ones (`config`) in the score.
- **`rankResults`** now takes a `RankContext { idfWeights? }`. Falls
  back to flat distinct-term counting when no IDF weights are provided.

> **Note on reverted work (10B — access-reinforced decay):** Phase 10 originally
> shipped an access-tracking sidecar (`.chrollo/access.json`) that recorded when
> each memory line was last read/injected and blended it into the recency score.
> **It was reverted before release.** The blend (`max(creationDecay, 0.7 ×
> accessDecay)`) was conservative and never hurt accuracy, but it added a
> sidecar file, I/O on every search, and a threaded `RankContext` — all to solve
> a problem nobody reported. The 30-day recency half-life already keeps memories
> around a long time, and the agent can always re-search with different
> keywords. This is the same shape as the async-I/O revert: an elegant-on-paper
> feature that added complexity without demonstrated value. See `docs/ARC.md`.

### Adversarial audit fixes

- **F-02** — `decideAmbientSearch` now compares the _previous_ prompt's
  distinctive terms against the current prompt's terms. Previously the previous
  set was overwritten before the comparison, making every same-topic follow-up
  skip the search and miss fresh context.
- **F-01** — `withInjectionBudget` now checks the `AbortSignal` after the
  wrapped function resolves, so the 50ms auto-injection budget is enforced for
  the formatting/injection path as well as the search itself.

---

## [0.1.12] — 2026-06

Last pre-audit release.
