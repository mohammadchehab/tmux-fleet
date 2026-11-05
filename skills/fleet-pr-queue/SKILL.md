---
name: fleet-pr-queue
description: Needs gh; no tmux. Use when the user asks for the PR queue, "what's open", "what's ready to merge", "what's red", "what's blocking", or before assigning PRs to the fleet. Runs the fleet-pr-queue script, which sorts every open PR into a bucket that names who acts next.
---

# Fleet PR Queue

Always run the script; never list PRs from memory or from fleet-context.md (it goes stale).

```bash
~/.claude/skills/fleet-pr-queue/scripts/fleet-pr-queue
```

| Bucket | Means | Next actor |
|---|---|---|
| READY | green, not draft, on main | pr-architect merges |
| RUNNING | checks still running | nobody yet; look again later |
| RED | a check failed | the branch's engineer fixes |
| NO-CI | no checks ran (stale/conflict) | engineer rebases on origin/main and pushes |
| STACKED | green but based on another branch | merges after its base PR |
| CHANGES | review asked for changes | author addresses them |
| DRAFT | draft | author finishes |

## Then

1. Hold anything fleet-context.md marks **held** (e.g. waiting on a product-owner decision), whatever its bucket.
2. Apply any extra merge gate the target repo's `AGENTS.md` sets (for example designer OK or e2e journeys on UI PRs).
3. Assign: READY → one message to pr-architect with the list. RED/NO-CI → the engineer whose branch it is (`engineer-1/...` prefix = engineer-1). One line per peer.
4. Report to the user as TLDR: totals line, then READY and RED in one line each.
