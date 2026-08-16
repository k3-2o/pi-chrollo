# Chrollo

> A retrieval layer for Pi's native session history. Search past conversations, read matched windows. No storage, no capture, no injection.

## Why

Pi records every session to disk as `.jsonl`. Nothing in Pi lets you search across that history when you're back in a conversation. Chrollo fills that one gap: **find what you worked on before, when you ask for it.**

It does not capture, summarize, store, or inject anything. Pi is the source of truth; Chrollo only reads it.

## Quick Start

Requires [ripgrep](https://github.com/BurntSushi/ripgrep) on your `PATH`.

```bash
sudo apt install ripgrep      # Linux
brew install ripgrep          # macOS

pi install npm:@k3_2o/pi-chrollo
```

Then in any Pi session, ask about something from a past conversation — the agent searches your history and reads back the relevant turns.

## How It Works

Two tools, one workflow:

1. **`search_memory`** — search past sessions by keyword. Returns markers like `path:line | role: preview`, most-recent sessions first.
2. **`read_memory`** — read a bounded window around a marker, rendered readably (`[HH:MM] role: text`).

The agent calls `search_memory` when you reference past work, picks a marker, then calls `read_memory` with that marker's line number to see the surrounding context.

```
you:    "what did we decide about the k3s ingress?"
agent:  search_memory("k3s ingress")  → 15 markers
        read_memory(path, offset=77, limit=10)  → readable window
```

## What It Does and Doesn't Do

| | |
|---|---|
| **Searches** | All of Pi's session history, by keyword |
| **Stores** | Nothing. Reads Pi's existing `.jsonl` files |
| **Captures** | Nothing. Pi already captures every turn |
| **Injects** | Nothing. You decide when to recall |
| **Calls an LLM** | Never |
| **Needs a daemon** | No. One binary (ripgrep) + native Node |

Tool outputs and internal reasoning are filtered out automatically — only real conversation turns appear in results and reads.

## Ranking

Chrollo keeps it boring on purpose.

- **One ripgrep call.** `rg --json --sort modified -m 5 -F -e <term> -i` searches the corpus **and** orders sessions by recency (file mtime) in a single pass — no BM25, no stemming, no typo fallback, no global stats scan.
- **Filter, then cap.** Each matched JSONL line is structurally filtered (drops tool outputs, thinking, metadata), capped at a few per session, and sliced to 15 markers.
- **Honest failure.** A real timeout says "timed out — retry", never a fake "no memories". Esc genuinely cancels the scan.

We give up per-line recency (mtime per file instead) and typo tolerance for ~4 source files that are easy to read.

## License

MIT — see [LICENSE](LICENSE).
