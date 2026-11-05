---
name: fleet-capacity
description: Needs tmux; reads Claude Code and Cursor peers' panes in fleet-<profile>-* tmux sessions. Use whenever the user asks about the fleet's capacity — "what's the capacity", "who is idle", "anyone sitting idle", "do we have capacity for X", "who's free". Always runs the fleet-capacity script first; never answers capacity from memory or fleet-context.md alone.
---

# Fleet Capacity

A capacity question is always answered by running the script. Never from memory, never from fleet-context.md alone (it goes stale).

## 1. Run the script

```bash
~/.claude/skills/fleet-capacity/scripts/fleet-capacity      # 2 last lines per peer
~/.claude/skills/fleet-capacity/scripts/fleet-capacity 5    # more context per peer
```

It prints, for every peer session of this fleet (`fleet-<profile>-*`, `fleet-*` with no profile):
- **CLI**: `claude` or `agent` (Cursor)
- **STATE**: `busy` (a turn is running), `asking` (idle, its last reply ends with a question: answer it, route it, or
  take it to the user), `held` (a peer message waits for the user to approve it in that pane — tell the user which
  panes), `unknown` (no input box on screen: a dialog or a review view), else `idle`
- **LAST OUTPUT**: the last lines of the peer's reply, without its CLI's chrome
- the totals, who is asking
- **Board** (the fleet's Backlog.md board, read with the pinned `backlog` CLI): each peer's In Progress card (assignee
  `@<peer>`), how many unassigned cards wait in **Next**, how many decisions are proposed (waiting on the user), and a line
  pairing the idle peers with that waiting work: `idle: engineer-2 · 3 tasks waiting in Next`. No board (no
  `$FLEET_STATE/backlog`, or no `backlog` CLI): the Active Team table from `$FLEET_STATE/fleet-context.md` instead.

- **In a stale worktree:** a peer whose pane sits in a merged, gone or idle worktree (from the last `fleet wt` scan, refreshed
  in the background): `engineer-2 (merged: feat-x #12 merged)`. Tell it to move on; the worktree goes with `fleet wt prune`.

The board's own session (`fleet-<profile>-board`) is not a peer: it is never listed or counted.

To read what a peer actually said, run `~/.claude/skills/fleet/scripts/fleet-peek [-n 20] <peer …>`. Never write your
own `tmux capture-pane` pipeline: these two scripts already strip the chrome and read both CLIs.

Also call `ListAgents`: it covers peers that are not in tmux (bg sessions, product-owner) and confirms busy/idle.

## 2. Answer

Lead with the count, then list by state:

```
Capacity: 8 peers — 3 busy, 5 idle.
Busy: pr-architect (#529 merge), engineer-1 (TASK-12, #516 CI), dev-support (local stack run)
Idle: engineer-2, designer, security-architect, architect, dev-support · 3 cards waiting in Next
Waiting on you: 2 proposed decisions
Bottleneck: <the gate everyone waits on, if any>
```

- An idle peer waiting on a review or a blocker is **blocked**, not free. Say what it waits on.
- If the question was "do we have capacity for X", name the idle peer who fits X's role.

## 3. Act (PM rules)

- Idle engineers get the next card from Next without asking the user (pm-token-lean-no-idle). One-line messages.
- Don't invent new work for idle peers (no-scope-expansion). If Next is empty, report that.
- Assign the card on the board (`backlog task edit <TASK-n> -a @<peer>`); no board: update `$FLEET_STATE/fleet-context.md`.
