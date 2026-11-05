---
name: code-graph
description: Needs node and a project with an Understand-Anything knowledge graph (.ua/ or .understand-anything/, made by /understand). Use when you need to find where something lives in a codebase, see what a file does, check what depends on a file before changing it, or get oriented in an unfamiliar area or layer, in any repo, before grepping or opening files.
---

# Code graph

Ask the project's knowledge graph small questions instead of reading files to find your way. Each answer is a few
hundred tokens; the graph file itself is often millions, so never open, cat or grep `knowledge-graph.json`.

```bash
node ~/.claude/skills/code-graph/scripts/code-graph.mjs <command> [args]
```

| Question | Command |
|---|---|
| Where is X handled? | `where <words...>` |
| What is this file, what does it define, who uses it? | `file <path or name>` |
| What could break if I change this? | `impact <path or name>` (`--depth 3` to go further) |
| What does this rely on? | `deps <path or name>` |
| What are the big parts of this codebase? | `layers`, then `layer <name>` |
| Where do I start in this repo? | `tours`, then `tour <n>` |
| Is the graph current? | `stats` |

`--limit N` widens a capped answer (default 15). `--graph <dir or file>` points at another project. Run with no
arguments for help. Inside a git worktree it finds the main checkout's graph and marks files your branch changed.

## How to work with it

1. Start with `where` or `layer` to get candidate files, then `file` on the best one. Give `where` two or three
   words, and run a second query with the code's likely names (the user's "reply budget" may be "hop budget" in code).
2. Before editing a file other code uses, run `impact` on it and read the step 1 dependents you might break.
3. Open only the files you will change or must read line by line. The graph tells you where; the file tells you how.
4. A file marked `*` changed after the graph was built: its summary and edges may be stale, so read the file itself.
   When `stats` says many files changed, ask the user to re-run `/understand` (it only re-analyzes changed files).

## Limits

- Summaries are written by a model when the graph is built. Trust them for finding code, not for exact behavior.
- Edges cover imports, calls and declared dependencies. Dynamic lookups (strings, registries, DI by name) are often
  missing, so `impact` is a floor, not the full set. Grep for the name when the change is risky.
- No graph found: the script says so. Use grep and the file tree as usual, and suggest `/understand` to the user.
