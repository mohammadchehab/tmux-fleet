---
name: codegraph
description: Needs node; scripts/codegraph-ensure installs the codegraph CLI and indexes the repo when either is missing. Use when you need to find where something lives in a codebase, read a symbol's source, see who calls it or what a change breaks, or get oriented in an unfamiliar area, in any repo, before grepping or opening files.
---

# CodeGraph

Ask the project's CodeGraph index instead of grepping and reading files. It parses the code (no model), a file watcher
keeps it current within about a second, and its answers carry the verbatim, line-numbered source, so a shown block
counts as read: edit from it, do not open the file again.

First make sure the CLI and the repo's index exist (it installs `@colbymchenry/codegraph` with npm when `codegraph` is
missing, runs `codegraph init -y` on the main checkout when there is no `.codegraph/`, and keeps `.codegraph/` out of
`git status`; with both in place it only says ok):

```bash
~/.claude/skills/codegraph/scripts/codegraph-ensure [repo path]
codegraph <command> [args] [-p <project path>]
```

| Question | Command |
|---|---|
| How does X work, where is X handled? | `explore "<symbol names or a question>"` |
| One symbol's source, its callers and callees | `node <name>` (`-f <file>` to pick one of several) |
| Read a file with line numbers and its dependents | `node -f <file>` (`--offset N --limit N`, `--symbols-only`) |
| Which symbols match a name? | `query <name>` (`-k function`, `-l 20`) |
| Who calls it, what does it call? | `callers <symbol>`, `callees <symbol>` |
| What could break if I change this? | `impact <symbol>` |
| Which tests cover the files I changed? | `affected <files...>` |
| Context for a task before I start | `context "<task>"` (`--no-code` for structure only) |
| What is in this repo? | `files` (`--filter <dir>`, `--max-depth N`) |
| Is the index current? | `status`; `sync` catches up, `index` rebuilds |

`-p <path>` points at another project (or any folder inside it); without it, the nearest `.codegraph/` at or above the
current directory is used. The `codegraph_explore` MCP tool, where an agent has it, gives the same output as `explore`.

## How to work with it

1. Start with one `explore` that names every symbol or file you expect the answer to span. One call usually answers
   the whole question; do not follow it with a grep and read loop over the same code.
2. Before editing a symbol other code uses, run `impact` (or read the blast radius `explore` prints) and check the
   dependents you might break; `affected` names the tests to run.
3. Open a file yourself only when CodeGraph did not show the part you need.

## Limits

- Dynamic lookups (strings, registries, DI by name) can still be missing, so `impact` is a floor. Grep for the name
  when the change is risky.
- No `codegraph` or no `.codegraph/`: run `codegraph-ensure` (above), then carry on. A worktree uses the main
  checkout's index, so it reflects the main checkout's files, not your branch's edits: read a file you changed.
- A lock left by a crashed indexer: `codegraph unlock`.
