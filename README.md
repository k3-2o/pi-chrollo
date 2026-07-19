# Chrollo

> Zero-cost agentic memory for Pi. Verbatim markdown + ripgrep. No LLM calls, no embeddings, no daemon.

---

## Quick Start

```bash
# Prerequisites
sudo apt install ripgrep          # Linux
brew install ripgrep              # macOS

# Install
pi install npm:@k3_2o/pi-chrollo
```

That's it. Your agent now remembers every turn. Try asking about something you worked on yesterday.

---

## What Chrollo Is

A Pi extension that stores every conversation turn verbatim in plain markdown files and retrieves them with ripgrep. No compression, no vectors, no extraction — just a file per session, findable by grep.

## Why Verbatim

Every other memory system compresses at write time — they decide what's important before they know what you'll ask. Chrollo stores everything and lets the agent figure out relevance at query time. The agent can always search again, read around a match, or try different keywords.

This approach (verbatim raw text) scored **92.0% accuracy** on the [locomo](https://agentmemorybenchmark.ai/dataset/locomo) agent-memory benchmark — ahead of vector+graph+LLM systems (80.3%) — at the cost of using ~2.4× more context tokens. Every design decision in Chrollo follows from that trade-off.

## Key Features

- **Auto-capture** — every turn saved to `.chrollo/memories/` automatically (project-scoped or global)
- **`read_memory` tool** — single-pass AND search with stemming and trigram typo fallback
- **Smart injection** — proximity-based recall before each prompt, gated on non-trivial prompts with new distinctive terms
- **Recency ranking** — line-level timestamps with 30-day half-life and IDF-weighted term scoring
- **Observability** — `.chrollo/metrics.jsonl` records every search/inject with latency and abort status

## Comparison

|                 | Others                               | Chrollo                  |
| --------------- | ------------------------------------ | ------------------------ |
| Write-time cost | LLM compression on every observation | $0 — append to a file    |
| Storage         | Binary KV store (unreadable)         | Plain markdown           |
| Search          | BM25 + vector + graph                | ripgrep + stemming       |
| Dependencies    | Binary daemon + npm deps             | Zero (Node.js + ripgrep) |

## Where to Go Next

- **[Tutorial](docs/TUTORIAL.md)** — 5-minute walkthrough: install, capture, search
- **[Architecture & Design](docs/ARC.md)** — how Chrollo works, trade-offs, what's not built
- **[How-to Guides](docs/GUIDES.md)** — project-scoped storage, import, monitoring, search tips
- **[Importing Existing Sessions](IMPORT.md)** — bring your Pi history into Chrollo
- **[Changelog](CHANGELOG.md)** — version history

## License

MIT — see LICENSE.
