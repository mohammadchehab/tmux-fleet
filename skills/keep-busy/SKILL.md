---
name: keep-busy
description: Claude Code only; needs tmux peers started by fleet-up. Use when the user wants the fleet kept busy, asks for a keep-busy timer or loop, says peers sit idle between check-ins, or says "/keep-busy" (start), "/keep-busy stop" or "/keep-busy tick". Usually run by the project-manager.
---

# Keep Busy

A 5-minute timer in this session. On each tick, every idle peer gets its next item and every waiting question gets an answer,
so nobody sits idle between the user's check-ins.

## Start ("/keep-busy")

1. `CronList`. If a job whose prompt starts with `Keep-busy tick` already exists, say so and stop. Never run two.
2. `CronCreate` with cron `*/5 * * * *` and this prompt:

   > Keep-busy tick. Follow the "Tick" section of the keep-busy skill. Reply in one line, or nothing if nothing changed.

3. Run one tick now.
4. Tell the user in one line: the timer runs every 5 minutes in this session only, stops when the session closes, expires
   after 7 days, and `/keep-busy stop` cancels it.

## Stop ("/keep-busy stop")

`CronList`, then `CronDelete` every job whose prompt starts with `Keep-busy tick`. Say how many you deleted.

## Tick

1. **Read the fleet.** Run `~/.claude/skills/fleet-capacity/scripts/fleet-capacity`. Never judge state from memory. With a
   board it ends with each peer's In Progress card, the unassigned cards waiting in **Next**, the decisions proposed, and a
   line pairing the idle peers with that waiting work (the `fleet-board` skill).
1b. **Read the replies.** Every Claude Code peer's reply lands in `$FLEET_STATE/replies.log` (Stop hook, one line each:
   time, peer, card/PR refs, `ASK` or `-`, the reply). Read only the lines added since your last tick: keep the line count
   you reached in `$FLEET_STATE/replies.offset` (`tail -n +$((offset+1))`). This is the record of what each peer said,
   and it survives the peer's `/clear`; prefer it to reading panes. Note the `ASK` lines for step 2.
2. **Asking peers** (an `ASK` line in step 1b, or the last reply ends with a question): answer from the accepted decisions
   (`~/.claude/skills/fleet-board/scripts/board-decision list accepted`), `scratchpad.md` and the target repo's `AGENTS.md`.
   If only the user can decide, record it with `board-decision ask` and tell the user once. Never ask the user again about
   something a decision already answers, or one that is still proposed.
3. **Held peers** (a message waits for approval in their pane): tell the user which peer and what it waits on. Never approve
   it yourself.
4. **Idle peers:** for each one, pick its next item as in the fleet-next skill, step 3: its own RED/NO-CI/CHANGES PRs
   first (`~/.claude/skills/fleet-pr-queue/scripts/fleet-pr-queue`), then a card in **Next** already assigned to it, then the
   top unassigned card in Next that fits its role (`backlog task list --status Next --plain`). Skip a card a decision holds,
   or one assigned to another peer. Assign the card before you send it (`backlog task edit <id> -a @<peer>`), then send it
   in one line:

   ```bash
   ~/.claude/skills/fleet/scripts/fleet-send "Next: <TASK-n> <title> — <one-line why>. Move it to In Progress when you start. Worktree <topic>." <peer>
   ```

   Nothing fits → leave the peer idle and note it. Never invent work or open new tickets.
5. **Busy peers:** leave them alone. Never interrupt a peer to hand it something.
5b. **Done worktrees:** run `~/.claude/skills/fleet/scripts/fleet-worktree prune --yes`. It removes merged, gone and
   orphaned worktrees that are clean and pushed, and names the ones it kept (dirty or unpushed). For each kept one, run
   `fleet-worktree remind` so its running owner is told once (recorded in `$FLEET_STATE/worktree-reminders`). Only a
   human removes a worktree with dirty or unpushed work.
6. **Record.** The assignment is on the board (step 4); no board: update the Active Team table in
   `$FLEET_STATE/fleet-context.md` instead. Log each call you made in `$FLEET_STATE/scratchpad.md`.
7. **Report** in one line: `keep-busy: assigned engineer-1 TASK-12, designer #418; answered architect; idle: engineer-2 (Next empty)`.
   Say nothing if nothing changed since the last tick.

`$FLEET_STATE` is this fleet's state folder: `~/.fleet-state/<profile>`, or `~/.fleet-state` with no profile. fleet-up gives
it to every peer.

## Rules

- Starting or stopping the fleet is the user's call. A tick never runs fleet-up, fleet-down or fleet-scale.
- An idle peer with nothing to do is reported, not filled with made-up work.
- A tick that finds the fleet down (no peer sessions) reports that once and does nothing else. Run `/keep-busy stop` when the
  user says the fleet is done for the day.
