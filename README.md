# Chrollo — Agentic Memory for Pi

[![npm](https://img.shields.io/npm/v/@k3_2o/pi-chrollo)](https://www.npmjs.com/package/@k3_2o/pi-chrollo)

**A philosophy, not a database.** Zero-cost memory that teaches your agent to remember.

---

## The Thesis

> *"Every other memory system was designed for non-agentic retrieval. They optimize benchmark scores. But in agentic systems, the agent is always there — it can grep, read, reason, iterate, search again. This changes everything."*

Chrollo trusts the agent. It doesn't compress, embed, summarize, or index at write time. It stores everything verbatim in plain markdown files and lets the agent do the work at query time.

**No LLM calls. No vector embeddings. No compression pipelines. No background daemon. Just grep + a thesaurus.**

The PwC paper *"Is Grep All You Need?"* (arXiv:2605.15184, May 2026) proved that grep is competitive with vector search in agentic contexts — because the agent is always in the loop and can iterate. Chrollo pushes that further: no vectors, no BM25, no embeddings. Just ripgrep + WordNet thesaurus + an agent that knows how to think.

---

## How It's Different

| | agentmemory / Mem0 / others | **Chrollo** |
|---|---|---|
| **Write-time cost** | LLM compression on every observation — $0.46–$5/mo | **$0 — just append to a file** |
| **Storage** | Binary KV store (unreadable) | **Plain markdown — cat, grep, open in Obsidian** |
| **Search** | BM25 + vector + graph (RRF fusion) | **ripgrep + WordNet thesaurus** |
| **Architecture** | Background daemon, 4 ports, Rust runtime | **Lives inside Pi's extension system** |
| **Dependencies** | iii-engine binary + npm deps | **Zero. Just Node.js + ripgrep** |
| **What it is** | An external database the agent queries | **The agent learning to remember** |

---

## What You Get

- **Verbatim capture** — every turn saved to `.chrollo/memories/*.md` automatically (project-scoped by default, falls back to `~/.chrollo/memories/`)
- **Zero information loss** — no compression, no summarization, no extraction
- **Auto-inject** — relevant past memories silently injected as context before every response
- **`read_memory` tool** — the agent searches across sessions using ripgrep + thesaurus
- **Recency scoring** — line-level timestamps so recent context ranks higher
- **WordNet thesaurus** — 606 words, 3,357 synonym pairs, 46KB. Zero runtime deps. Ships with the extension, no build step needed.
- **Grep-compatible** — `rg "python" .chrollo/memories/` works on any machine
- **Zero cost** — no API keys, no LLM calls, no server to maintain

---

## Quick Install

```bash
# Prerequisites
sudo apt install ripgrep          # Linux
brew install ripgrep              # macOS

# Install via npm (recommended)
pi install npm:@k3_2o/pi-chrollo

# Or via GitHub
pi install git:github.com/k3-2o/pi-chrollo

# Or clone manually
cd ~/.pi/agent/extensions
git clone https://github.com/k3-2o/pi-chrollo.git

# Memories are stored per-project under .chrollo/memories/
# Add .chrollo/memories/ to .gitignore or commit it — your choice
# Override location: export CHROLLO_MEMORIES_DIR=/path/to/memories

# Reload Pi — extension auto-loads
# /reload in Pi
```

---

## The Codebase

```
976 lines of TypeScript. 6 modules. Zero runtime dependencies.

chrollo/
├── index.ts          ← Pi extension wiring (hooks, tools, commands)
└── src/
    ├── capture.ts    ← Turn capture (extractText, formatToolCall)
    ├── format.ts     ← Output formatting + TUI rendering
    ├── search.ts     ← Retrieval engine (ripgrep + thesaurus + recency)
    ├── stats.ts      ← Memory statistics
    └── storage.ts    ← File I/O (create, append, read)
```

---

## Philosophy (Not Features)

Chrollo is built on four axioms that everything else follows from:

1. **Don't decide what's important at write time.** Store everything verbatim. Let the agent figure out relevance at query time.

2. **The agent is always in the loop.** It can read, reason, iterate, and search again. Vector search optimizes for perfect first-shot retrieval, which solves the wrong problem.

3. **Plain text is the universal interface.** Markdown files that `cat`, `grep`, `rg`, `less`, and Obsidian can all read. No binary formats, no proprietary stores.

4. **Zero-cost infrastructure.** The engine is file I/O + string operations + calling `rg`. No APIs, no LLMs, no background servers. It costs nothing to run and nothing to maintain.

The full architecture and design decisions are documented at [`docs/ARC.md`](docs/ARC.md).
