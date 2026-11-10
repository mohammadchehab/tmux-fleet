---
name: fleet-next
description: Needs gh and the fleet's board (backlog CLI; fleet-context.md without one); no tmux. Use when a peer reports a PR merged/done and asks "next?", or when a PR closes. Verifies the merge, makes sure its worktree is gone, gives the peer its next item in the same message, and records it on the board.
---

# Fleet Next — done → next

## 1. Verify the done claim

```bash
gh pr view <PR> --json state,mergedAt,headRefName --jq '"\(.state) \(.mergedAt) \(.headRefName)"'
```

Not MERGED → tell the peer what is missing (red check, review, stacked base). Don't hand out the next item.

## 2. Worktree

```bash
git -C <target repo> worktree list | grep -F "<headRefName>"
```

Still listed → the peer removes it (`git worktree remove <path>`). Peers own their worktrees; the PM never deletes one (worktree-sweep-rules).

## 3. Pick the next item

Run `~/.claude/skills/fleet-pr-queue/scripts/fleet-pr-queue` and read the board's **Next** column
(`backlog task list --status Next --plain`). Pick, in order:
1. a RED / NO-CI / CHANGES PR on that peer's own branches
2. a PR stacked on the one that just merged (it can now retarget main)
3. a card in Next already assigned to that peer
4. the top unassigned card in Next matching the peer's role, else the oldest unowned PR for its role (engineer: RED/NO-CI;
   pr-architect: READY; designer: UI PRs)

Skip a card an accepted decision holds. Nothing fits → tell the peer the queue is empty. No new tickets or cards
(no-scope-expansion).

## 4. One message

```
#<PR> merged ✓. Worktree <name> gone? Next: <TASK-n or #N> — <one-line why>. Move the card to In Progress when you start. Worktree <topic>.
```

## 5. Record

On the board: the finished card goes to **Done** (if the peer has not moved it), the next card is assigned
(`backlog task edit <TASK-n> -a @<peer>`). No board: update the peer's row in `$FLEET_STATE/fleet-context.md` (PR, state,
time) and drop the merged PR from the queue.
