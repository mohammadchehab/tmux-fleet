---
name: fleet-scale
description: Needs tmux; its busy check reads Claude Code and Cursor panes. Use when the user wants to scale the team — add a resource/peer ("add an engineer", "we need another architect", "spin up a designer"), remove one ("drop engineer-3", "we don't need a designer today"), or rebalance after a capacity check. Runs the fleet-scale script, which adds or removes one peer without touching the others.
---

# Fleet Scale — add or remove a resource

Look first: run `~/.claude/skills/fleet-capacity/scripts/fleet-capacity 1` and `~/.claude/skills/fleet-pr-queue/scripts/fleet-pr-queue`. The numbers back the recommendation.

## Add a peer

```bash
~/.claude/skills/fleet-scale/scripts/fleet-scale roles            # what roles exist
~/.claude/skills/fleet-scale/scripts/fleet-scale add engineer     # next free name: engineer-3
~/.claude/skills/fleet-scale/scripts/fleet-scale add engineer 2   # two more
~/.claude/skills/fleet-scale/scripts/fleet-scale add designer     # bare name if none runs
```

It goes through `fleet-up`: a worktree `.claude/worktrees/<name>` at origin/main, `/rename <name>`, `/fleet <role>`, with the model from `fleet/models`. The other peers keep running. The `fleet-<profile>` view is rebuilt with everyone in it.

Then, in the same turn:
1. Give the new peer its first item from the queue (one line, its worktree branch `<name>/<topic>`).
2. Add its row to the Active Team table in `$FLEET_STATE/fleet-context.md`.

When to add (say which applies):
- the queue has more RED/NO-CI items than idle engineers can take
- a gate is the bottleneck (e.g. one pr-architect with 10+ READY). Then add that role, not more engineers.

## Remove a peer

```bash
~/.claude/skills/fleet-scale/scripts/fleet-scale remove engineer-3
```

It refuses (exit 2) while the peer is busy, has uncommitted files, or has unpushed or never-pushed commits, and lists what is wrong. Before removing:
1. Tell the peer to push and finish or hand over its open PRs. Wait for its reply.
2. Re-assign each of its PRs to another peer, and update fleet-context.md (drop its row, note the new owners).
3. Run the remove. Use `-f` only if the user says to discard that peer's work.

The worktree is kept. The peer (or a later sweep) removes it once its PRs are merged or closed (worktree-sweep-rules).

When to remove: idle with an empty queue for its role, or the user says so. Never the project-manager, and never a peer holding the local environment lock.

## Swap a role

Remove, then add: `remove engineer-3`, then `add e2e-engineer`.

## Report

```
Scaled: +engineer-3 (on #503), −designer-2 (its #521 → designer). Fleet now 8: 3 busy, 5 idle.
```
