# How-to Guides

> Practical tasks for getting the most out of Chrollo.

---

## How to Set Up Project-Scoped Storage

By default, memories go to `~/.chrollo/memories/` (global). To scope memories to a specific project:

```bash
mkdir -p my-project/.chrollo/memories
```

Chrollo walks up from your working directory looking for `.chrollo/` directories. The nearest one wins. If none is found, it falls back to `~/.chrollo/memories/`.

**To make a project's memories available globally**, copy the folder:

```bash
cp -r my-project/.chrollo ~/.chrollo/
```

**Why project-scoped?** Your project's `.chrollo/` can live in git alongside the code. Clone the repo anywhere and the memories come with it.

**Why global?** Memories persist across projects — ask about something you worked on in a different repo and it's still findable.

To always use a custom location regardless of cwd, set:

```bash
export CHROLLO_MEMORIES_DIR=/path/to/my/memories
```

---

## How to Import Existing Pi Sessions

Chrollo ships with a script that walks your Pi session history and converts it to native memory files:

```bash
./scripts/import-pi-sessions.sh
```

### What it imports

- Every `user` and `assistant` message from Pi session JSONLs
- Tool calls alongside prose (wrapped in `<tool>...</tool>`)
- Timestamps in local time (matches native capture format for correct recency scoring)

### What it skips

- System messages (`session`, `model_change`, `thinking_level_change`)
- Compaction records and tool results
- Already-imported sessions (deduplicated by session ID prefix)

### Commands

```bash
# Default: src = ~/.pi/agent/sessions, dest = ~/.chrollo/memories
./scripts/import-pi-sessions.sh

# Preview without writing
./scripts/import-pi-sessions.sh --dry-run

# Custom paths
./scripts/import-pi-sessions.sh /path/to/sessions /path/to/memories
```

Re-running is safe — the script deduplicates by session ID prefix.

### For other harnesses (Codex, Claude Code, etc.)

The JSONL structure differs per harness. Same idea: flatten messages into `[timestamp] [role]\ncontent` format matching Chrollo's line-date regex. You'll know your own schema better than any generic importer would.

---

## How to Monitor Injection Health

Chrollo records every search and injection to `.chrollo/metrics.jsonl`:

```bash
# How often does auto-injection exceed its 50ms budget?
grep '"aborted":true' .chrollo/metrics.jsonl

# Average injection latency
jq -s 'map(select(.kind == "inject")) | add | .latencyMs / length' .chrollo/metrics.jsonl

# Latest 10 records
tail -10 .chrollo/metrics.jsonl | jq .
```

A high abort rate means the proximity search is taking too long for your corpus size. The first debugging step is gating: is the injection skipping prompts it shouldn't? Check that `isTrivialPrompt` and `sameTerms` are correctly classifying your prompt patterns.

To clear the metrics file (keeps the file, empties contents):

```bash
just clean-metrics
```

---

## How to Search Memory Effectively

Chrollo's `read_memory` tool performs a single-pass AND search: **all search terms must appear in the same file**. If nothing comes up, the tool falls back to a trigram typo match (OR across 3-char sub-patterns).

### Tips

- **Use distinctive terms.** Common words like "function" or "project" match too many files to be useful. Use the identifiers, filenames, and unique phrases you remember.
- **Search for code identifiers.** `optimizeRerenders` finds the memory where `optimizeRerenders` was discussed. Chrollo splits camelCase at index time, so `optimize renders` works too.
- **Try morphological variants.** `deployment` finds `deploy` — stemming covers inflections.
- **If AND fails, reword.** The agent iterates (Axiom 2). Change one search term and try again.
- **Read around the marker.** Results return `path:line | text` — a compact marker, not full context. Use `read path:line --offset -10 --limit 20` to read around the match.
- **Check the trigger terms.** `read_memory` returns the matched terms per line. If unexpected terms triggered, adjust your query.

### What NOT to do

- Don't ask for summaries of a search. The tool returns lines, not synthesis. Use the agent's reasoning to connect the dots.
- Don't read full files. Read around the matched line with `--offset` and `--limit`. Full-file reads waste tokens.

---

## How to Back Up and Share Memories

Memory files are plain markdown. Back them up however you back up files:

```bash
# Global memories
cp -r ~/.chrollo/memories/ /your/backup/location/

# Or commit them to a repo (project-scoped memories already live there)
```

For sharing between machines, `rsync`, `git`, or `Dropbox` all work. The files have no binary dependencies — every system can read them.
