---
name: fleet-standup
description: Needs tmux and gh; busy state reads Claude Code and Cursor panes (fleet-capacity). Use when the user asks for a standup, status report, "where are we", "fleet status", a daily summary, or at the start of a PM session. Combines capacity, the PR queue and blockers into one short report and refreshes fleet-context.md.
---

# Fleet Standup

## 1. Gather (run both, in parallel)

```bash
~/.claude/skills/fleet-capacity/scripts/fleet-capacity 1
~/.claude/skills/fleet-pr-queue/scripts/fleet-pr-queue
~/.claude/skills/fleet/scripts/fleet-worktree summary          # this profile's worktrees, e.g. "12, 3 stale, 4.1 GB"
~/.claude/skills/fleet/scripts/fleet-worktree ls --stale --no-size   # which ones, and whether they hold dirty or unpushed work
```

Plus `ListAgents` (peers outside tmux), the board (fleet-capacity's Board lines: each peer's card, what waits in Next, the
proposed decisions; blocked cards: `backlog task list -l blocked --plain`) and the **Triage**
section of `$FLEET_STATE/fleet-context.md`.
Merged since last standup: `gh pr list --state merged --search "merged:>=$(date -v-1d +%F)" --json number,title --jq '.[]|"#\(.number) \(.title)"'`

## 2. Report (this shape, nothing more)

```
Fleet <date>: <N> peers — <b> busy, <i> idle, <h> held. <P> open PRs — <r> ready, <x> red.
Merged (24h): #529, #515, …
In flight:  engineer-1 TASK-12 #516 CI · pr-architect merge queue · dev-support local stack run
Waiting:    <n> cards in Next · board <URL>
Blocked:    TASK-9 #516 on decision-3 (owner: <who>)
Idle:       engineer-2 → assigning TASK-14
Worktrees:  12, 3 stale (2 merged, 1 idle), 4.1 GB · fleet wt prune
Needs you:  <the proposed decisions (board-decision list proposed), panes with held messages, stale worktrees with dirty or
            unpushed work (only a human decides those)>
```

- "Needs you" lists only what the user must do. If nothing, write `nothing`.
- Don't re-ask the user a decision already on the board (accepted, or proposed and asked already).

## 3. Act and record

- Give every idle engineer the next card from Next, assigned to it on the board (one line each); no new work invented.
- The board already holds who has what, the queue, blockers and decisions. Rewrite fleet-context.md with what the board does
  not hold: date, Open PRs by bucket (drop merged PRs), Triage. No board: also the Active Team table and Blockers, as before.
