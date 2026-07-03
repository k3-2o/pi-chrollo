# Import — Bring Your Existing History

Chrollo starts fresh by design. No importer, no migration CLI, no onboarding script.

But if you have existing Pi (or other harness) sessions and want them in Chrollo's memory store, the tools are already in your hands:

```bash
# Pi JSONL → Chrollo markdown
for f in ~/.pi/agent/sessions/*/*.jsonl; do
  jq -r 'select(.type=="message") | "[\(.timestamp)] [\(.message.role)]\n\(.message.content | map(.text)//empty | join("\n"))\n"' "$f" \
    > ".chrollo/memories/$(basename "$f" .jsonl).md"
done
```

That's it. One loop. Five minutes.

### What it does

- Walks every Pi session JSONL
- Extracts only messages (skips system events, model changes, tool calls)
- Writes them as timestamped markdown files in your `.chrollo/memories/` directory
- Deduplicates by filename — re-running won't overwrite existing sessions

### For other harnesses (Codex, Claude Code, etc.)

The JSONL structure differs per harness. Same idea though — `jq` or a quick script to flatten messages into `[timestamp] [role]\ncontent` format. You'll know your own schema better than any generic importer would.

### Why no built-in importer?

The same reason Chrollo doesn't embed, compress, or summarize at write time: **the agent is always in the loop.** If you want your old sessions in memory, you can already do it with tools you have. Building a polished import pipeline would be building a bridge to a place that's already a short walk away.

Start now. The past is just data.
