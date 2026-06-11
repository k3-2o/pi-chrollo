# Chrollo — Agentic Memory for Pi

Auto-captures every conversation into markdown files. Grep-based retrieval with WordNet synonym expansion. The agent remembers what you've done across sessions.

## Setup

```bash
cd ~/.pi/agent/extensions && git clone https://github.com/k3-2o/pi-chrollo.git
sudo apt install ripgrep     # Linux
brew install ripgrep         # macOS
# Do /reload in Pi — extension auto-loads. The ~/.chrollo/ directory
# is created on first use. Optionally run `npm run build-thesaurus`
# inside the repo for WordNet synonym support.
```

No config, no API keys, no runtime dependencies.

## What you get

Every turn — your prompts, the agent's responses, tool calls — gets saved verbatim to `~/.chrollo/memories/`. One file per session.

The agent has two ways to recall:
- **Auto-inject** — relevant past memories are silently injected as context before every response
- **`read_memory` tool** — the agent can search explicitly for deeper context

`/recall` shows memory stats (session count, turn count).

## Memory format

```markdown
[2026-06-11 00:20:27] [User]
what's my best language?

[2026-06-11 00:20:27] [Agent]
> read_memory python preference
>
> Based on our conversations, you said **Python** is your preference.
```

Agent responses are blockquoted so internal markdown doesn't clash. Timestamps on every line enable recency scoring across resumed sessions.
