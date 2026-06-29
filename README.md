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
- **Auto-inject** — proximity-based memory injection with 50ms hard timeout. Never blocks rendering. Injects up to 10 compact results + `(+N more — use memory intelligently)` heads-up.
- **`read_memory` tool** — AND-mode search (all terms must co-occur). Compact output: `path:line | text`. Up to 20 results per search.
- **Recency scoring** — line-level timestamps so recent context ranks higher. Score = `matchedTerms × recencyMultiplier`.
- **Corpus-aware term extraction** — dynamically filters words that appear in >30% of memory files, keeping auto-injection focused on distinctive terms.
- **Thesaurus fallback** — 606 words, 3,357 synonym pairs. Only activates as last resort when AND search returns nothing. Never used in auto-injection.
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
```

Memories are stored globally under `~/.chrollo/memories/` by default. For project-scoped storage, create a `.chrollo/memories/` directory in your project root — Chrollo will prioritise it over the global one. You can always copy a project's `.chrollo/` folder back to `~/.chrollo/` if you want those memories available globally.

**Version your memories.** Your `.chrollo/memories/` files are plain markdown — they belong in git (or whatever backup you use). Commit them, push them, clone them with your project. If you use project-scoped storage, your memories travel with the repo. If you use global storage, back up `~/.chrollo/` the same way you back up your dotfiles.

---

---

## Philosophy (Not Features)

Chrollo is built on four axioms that everything else follows from:

1. **Don't decide what's important at write time.** Store everything verbatim. Let the agent figure out relevance at query time.

2. **The agent is always in the loop.** It can read, reason, iterate, and search again. Vector search optimizes for perfect first-shot retrieval, which solves the wrong problem.

3. **Plain text is the universal interface.** Markdown files that `cat`, `grep`, `rg`, `less`, and Obsidian can all read. No binary formats, no proprietary stores.

4. **Zero-cost infrastructure.** The engine is file I/O + string operations + calling `rg`. No APIs, no LLMs, no background servers. It costs nothing to run and nothing to maintain.

Get the full scope — the design choices, trade-offs, and philosophy that went into building Chrollo: [`docs/ARC.md`](docs/ARC.md).
