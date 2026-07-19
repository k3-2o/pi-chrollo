# Tutorial: Your First Chrollo Memory

> 5 minutes. Zero config. By the end, your agent will remember what you say
> and find it again with a search.

---

## Prerequisites

- Pi installed (you're already using it)
- ripgrep installed (`sudo apt install ripgrep` or `brew install ripgrep`)

## Step 1: Install Chrollo

```bash
pi install npm:@k3_2o/pi-chrollo
```

You should see:

```
Installed chrollo. Restart Pi to activate.
```

## Step 2: Restart Pi

Close your current Pi session and start a new one. When Pi reloads, you should see a notification in the lower-right:

```
Chrollo: 288 memories across 288 sessions
```

The numbers will differ based on how many memories you already have. The notification means Chrollo loaded successfully.

## Step 3: Say Something Worth Remembering

Open a new Pi session and type a distinctive prompt — something with a specific term you can search for later:

```
what's the k3s ingress deployment procedure?
```

Wait for the agent to respond. That's it — Chrollo captured the turn automatically. The file is sitting in `~/.chrollo/memories/` right now.

## Step 4: Search for What You Said

In the same session (or a new one), type:

```
read_memory(query: "k3s ingress")
```

The agent will call the `read_memory` tool and you should see output like:

```
read_memory "k3s ingress"
  · 3 sessions
```

Expanding the result shows:

```
~/.chrollo/memories/2026-07-19_111234_abcdef01.md:42 | [2026-07-19 11:12:34] [User]
what's the k3s ingress deployment procedure?
~/.chrollo/memories/2026-07-19_111234_abcdef01.md:43 | [2026-07-19 11:12:34] [Agent]
> The k3s ingress controller works by...
~/.chrollo/memories/2026-07-19_111234_abcdef01.md:45 | [2026-07-19 11:12:34] [Agent]
> Use the following ConfigMap to set it up...
(+2 more — use memory intelligently)
```

The `path:line | text` format tells the agent exactly where to read. The "(+N more)" heads-up tells it there's more context available if it needs to read around the matches.

## Step 5: Verify the File

Chrollo stores everything in plain markdown. You can see the raw file yourself:

```bash
ls ~/.chrollo/memories/
cat ~/.chrollo/memories/2026-07-19_111234_abcdef01.md
```

You'll see a file with YAML frontmatter and conversation lines:

```markdown
---
session_id: "abcdef01-1234-5678-9abc-def012345678"
date: "2026-07-19"
harness: "pi"
cwd: "/home/you/projects/my-project"
---

[2026-07-19 11:12:34] [User]
what's the k3s ingress deployment procedure?

[2026-07-19 11:12:34] [Agent]

> The k3s ingress controller works by...

[2026-07-19 11:12:34] [Agent]

> Use the following ConfigMap to set it up...
```

That's it. You've seen the full cycle: capture → store → retrieve. Every future turn follows the same path automatically.

## What You've Learned

- Chrollo captures every turn without being asked
- Memory files are plain markdown — open them in any editor
- `read_memory` finds past conversations with AND search
- The agent reads compact `path:line` results and expands them with `read`

## Next Steps

- **[How-to Guides](GUIDES.md)** — project-scoped storage, import Pi history, monitor injection health
- **[Architecture & Design](ARC.md)** — how retrieval works, design decisions, what's not built
