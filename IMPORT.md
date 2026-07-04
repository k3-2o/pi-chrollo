# Import — Bring Your Existing History

Chrollo starts fresh by design. No importer, no migration CLI, no onboarding script.

But if you have existing Pi sessions and want them in Chrollo's memory store, the tools are already in your hands:

```bash
./scripts/import-pi-sessions.sh
```

That's it. One script. Sub-second for a hundred sessions.

### What it does

- Walks every Pi session JSONL under `~/.pi/agent/sessions/`
- Extracts only `user` and `assistant` messages with visible text — skips `session`, `model_change`, `thinking_level_change`, `compaction`, `toolResult`, and any thinking-only / toolCall-only empties
- Writes native-format markdown into `~/.chrollo/memories/`:
  - filename: `YYYY-MM-DD_HHMMSS_<session-id-prefix>.md` (matches Chrollo's file-date regex, so imports get real recency scoring)
  - YAML frontmatter: `session_id`, `date`, `harness`, `cwd`, `parent_session`
  - `[YYYY-MM-DD HH:MM:SS] [User|Agent]` line headers (matches Chrollo's line-date regex)
  - agent turns blockquoted with `>`
- Deduplicates by session-id prefix — re-running won't write duplicates even if timestamps differ by timezone (works correctly alongside natively-captured sessions)
- Tolerant of corrupted JSONL: strips leading whitespace and embedded null bytes before parsing
- Local-time timestamps (matches chrollo's native convention, so imports and live-captured files rank identically in the recency machinery)

### Usage

```bash
# default: src = ~/.pi/agent/sessions, dest = ~/.chrollo/memories
./scripts/import-pi-sessions.sh

# preview without writing
./scripts/import-pi-sessions.sh --dry-run

# custom paths
./scripts/import-pi-sessions.sh /path/to/sessions /path/to/memories
```

### Why no tool calls? (the one inconsistency with native capture)

Native Chrollo capture *does* write tool calls and their results — it follows the axiom *don't decide what's important at write time*, so it stays dumb and faithful. The importer deliberately doesn't. Different context, different rule:

- **Native capture is live.** It can't know in the moment which command will matter later, so it keeps everything.
- **The importer is a one-shot migration.** The sessions are already finished — the agent's prose conclusions already exist. Compression is the whole point, not faithfulness.

For what Chrollo's memory store is actually used for — recency-grounded prose retrieval — tool calls are mostly tax. When an agent searches memory, the useful hits are the agent's reasoning and the user's framing, not the `bash`/`edit`/`read` invocations those conclusions came from. The raw JSONL at `~/.pi/agent/sessions/` remains the source of truth for execution detail if it's ever needed; the importer compresses into what the retrieval machinery can actually use.

### For other harnesses (Codex, Claude Code, etc.)

The JSONL structure differs per harness. Same idea though — `jq` or a quick script to flatten messages into `[timestamp] [role]\ncontent` format. You'll know your own schema better than any generic importer would.

### Why no built-in importer?

The same reason Chrollo doesn't embed, compress, or summarize at write time: **the agent is always in the loop.** If you want your old sessions in memory, you can already do it with tools you have. Building a polished import pipeline would be building a bridge to a place that's already a short walk away.

Start now. The past is just data.
