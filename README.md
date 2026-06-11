# Chrollo — Agentic Memory for Pi

Auto-captures every conversation into markdown files. Grep-based retrieval with WordNet thesaurus expansion. The agent remembers what you've done across sessions.

976 lines of TypeScript. Zero runtime dependencies.

## Setup

```bash
# 1. Clone into Pi's extensions directory
cd ~/.pi/agent/extensions && git clone https://github.com/k3-2o/pi-chrollo.git

# 2. Install ripgrep (system dependency)
sudo apt install ripgrep   # Linux
brew install ripgrep       # macOS

# 3. Generate thesaurus (optional but recommended)
cd ~/.pi/agent/extensions/pi-chrollo
npm install && npm run build-thesaurus

# 4. Do /reload in Pi or restart — extension auto-loads
#    The ~/.chrollo/memories/ directory is created on first use
```

That's it. No config. No API keys.

## What You Get

Everything is automatic. Every turn — user text, agent responses, tool calls — gets saved verbatim to `~/.chrollo/memories/`. One markdown file per session.

The agent has two ways to recall:

- **Auto-inject** — every prompt, relevant memories from past sessions are silently injected as context before the agent responds
- **`read_memory` tool** — the agent can search explicitly when it needs deeper context. It returns matching lines with line numbers so it can `read --offset --limit` around them

## Memory file format

```markdown
[2026-06-11 00:20:27] [User]
what's my best language?

[2026-06-11 00:20:27] [Agent]
> read_memory python preference
>
> Based on our conversations, you said **Python** is your preference.
```

Agent responses are blockquoted so internal markdown doesn't clash. Tool calls are captured in chronological order — text before a tool call comes first, then the tool call, then more text. Per-line dates enable correct recency scoring even for resumed sessions.

## Commands & Tooling

```bash
npm run format     # prettier --write 'index.ts' 'src/*.ts' 'scripts/*.ts'
npm run check      # format check + smoke test (verifies all modules load)
npm run build-thesaurus  # generate WordNet thesaurus (one-time)
```

| Command | Purpose |
|---|---|
| `/recall` | Show memory stats (session count, turn count) |

## Project Structure

```
chrollo/
├── index.ts            ← Entry — factory, hooks, tool & command registration
├── package.json        ← pi.extensions: ["./index.ts"]
├── .prettierrc.json
├── README.md
├── docs/               ← Architecture docs (implementation-state, trade-offs)
├── scripts/
│   └── build-thesaurus.ts
└── src/
    ├── capture.ts      ← Turn capture (extractText, formatToolCall)
    ├── format.ts       ← Output formatting (formatResultsForContext, renderCall, renderResult)
    ├── search.ts       ← Retrieval (ripgrep, thesaurus, recency scoring)
    ├── stats.ts        ← Memory statistics
    └── storage.ts      ← File I/O (create, append, read, path resolution)
```

## Requirements

- Node.js v20+ (Pi requirement)
- ripgrep (`rg`) — for fast file search
- Zero npm dependencies at runtime

## How It Works

Three Pi lifecycle hooks drive capture:

1. **`session_start`** — create storage dir, store session metadata, defer file creation
2. **`before_agent_start`** — capture prompt, auto-search memories, inject context
3. **`agent_end`** — build chronological sections (text + tool calls), write to file

Retrieval is two-layer: exact ripgrep first (~70% of queries), WordNet thesaurus fallback (+~20%). Recency is a gentle nudge (today = 2×, 30 days = 1.03×). No vectors, no embeddings, no config.
