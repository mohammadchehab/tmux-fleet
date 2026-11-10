---
name: fleet-clear
description: Claude Code only; needs tmux peers started by fleet-up. Keeps fleet token use down by clearing every idle peer whose context is over a token limit (default 150000), after it saves its state, then reloading its role and state; the project-manager gets its handoff and loop back. Use when the user asks to clear the fleet, save tokens, check the peers' context, or set up the clear loop ("/fleet-clear", "/fleet-clear loop").
---

# Fleet Clear

Peers now clear themselves: the `fleet-context-guard` Stop hook (fleet skill) makes a peer over `FLEET_CLEAR_LIMIT` write its state
and hand off at the end of its turn. This skill stays for manual use: clear the whole fleet now, or check the peers' counts.

Every peer re-reads its whole context on each turn, so a peer at 900k tokens costs about six times as much per message as one
at 150k. Claude Code only warns near the limit, so the pane is not a usable signal. This skill reads each peer's real token
count from its session log and clears early.

## 1. Run it once

```bash
~/.claude/skills/fleet-clear/scripts/fleet-clear -n    # dry run: each peer over the limit, nothing sent
~/.claude/skills/fleet-clear/scripts/fleet-clear       # clear them
~/.claude/skills/fleet-clear/scripts/peer-tokens engineer-1=<its worktree>   # one peer's count
```

A full run waits for each peer to save before clearing it, a minute or more per peer, so run it with Bash
`run_in_background: true`. Then report in one line: who was cleared, or "nothing to clear".

For each idle peer over the limit:
1. The peer writes `$FLEET_STATE/<peer>-state.md`. The project-manager writes `$FLEET_STATE/handoff.md` instead.
2. `/clear`, then `/fleet <role>`, then each command in `FLEET_CLEAR_AFTER`.
3. The peer reads its state file. The project-manager reads the handoff and the scratchpad and gets `FLEET_PM_LOOP` back.

Busy peers are skipped and retried on the next run. A lock in `$FLEET_STATE` stops two runs from overlapping.

## 2. Loop it ("/fleet-clear loop")

Schedule the run every 8 minutes in this session with `CronCreate`, cron `*/8 * * * *`. Use this prompt:

> Fleet clear loop. Run ~/.claude/skills/fleet-clear/scripts/fleet-clear with Bash, run_in_background true. Reply in one line: who was cleared, or "nothing to clear".

Tell the user three things. The loop lives only in this session, it stops when the session closes, and it expires after 7 days.
Cancel it with `CronDelete`.

## Settings

Set these in the environment, or in the profile (`~/.config/fleet/profiles/<name>.env`, read when `FLEET_PROFILE` is set):

| Key | Default | What |
| :- | :- | :- |
| `FLEET_CLEAR_LIMIT` | `150000` | Tokens above which a peer is cleared: at the end of its turn by the context-guard hook, or by `fleet-clear` when run by hand |
| `FLEET_CLEAR_AFTER` | none | Commands sent after the role reloads, separated by `;` (for example `/i-have-adhd`) |
| `FLEET_PM_LOOP` | `/keep-busy` (the keep-busy skill's 5-minute timer) | The line the project-manager gets back to restart its loop |
| `FLEET_STATE` | `~/.fleet-state/<profile>` (`~/.fleet-state` with no profile) | Where state files and the handoff go |

## Rules

- Never clear a busy peer. Its in-flight work would be lost.
- `fleet-clear-heavy` (in the fleet skill) reads a pane hint that current Claude Code no longer shows. Use this skill instead.
