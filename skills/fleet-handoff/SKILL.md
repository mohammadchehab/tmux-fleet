---
name: fleet-handoff
description: Claude Code only; needs the peer to run in a fleet-<profile>-<peer> tmux session. A peer (or the project-manager) writes its handoff and clears its own session, then a fresh copy reloads its role and carries on from the handoff. Use when a peer's context is long or slipping, after a compaction warning, or when the user says "hand off", "write your handoff and clear", "/fleet-handoff".
---

# Fleet Handoff

You hand over to a fresh copy of yourself. Your context is wiped; only what you write survives. State lives in
`$FLEET_STATE` (default `~/.fleet-state/<profile>`, `~/.fleet-state` with no profile).

## 1. Write the handoff

**Any peer:** write `$FLEET_STATE/<peer>-state.md` (your peer name is your tmux session, `fleet-<profile>-<peer>`, or `fleet-<peer>` with no profile):

```
# <peer> handoff — <date time>
Item: <Jira key> — <one line>; PR/MR: <number or none>
Worktree / branch: <path> — <branch>; uncommitted: <yes, what | no>
Done so far: …
Next step, exactly: …
Waiting on: <who, for what | nothing>
Do not: … (anything the next copy must avoid)
```

**The project-manager:** bring `scratchpad.md` up to date, then write `handoff.md` in the format in
`fleet/roles/project-manager.md` ("Your own context"), plus one line `Loop: <the /loop line in force, or none>`.

Commit or stash nothing on the user's behalf just for the handoff; say what is uncommitted instead.

## 2. Clear yourself

```bash
~/.claude/skills/fleet-handoff/scripts/fleet-handoff        # the peer whose pane runs it
~/.claude/skills/fleet-handoff/scripts/fleet-handoff <peer> # another peer, after it wrote its state file
```

It checks the state file exists, starts a detached waiter and returns at once. **End your turn right after.** Once your
pane is idle the waiter types, each after the pane is idle again: `/clear`, `/fleet <role>`, each command in
`FLEET_CLEAR_AFTER`, then "read your state file" (the project-manager: the handoff and the scratchpad, and restart
the loop it names). Log: `$FLEET_STATE/handoff-<peer>.log`.

## Rules

- Write the file before running the script; the script refuses without it.
- Never hand off mid-change you cannot describe: finish the step, or write exactly where it stopped.
- `fleet-clear` does the same for every idle peer over a token limit, from the outside. This skill is the peer's own
  choice, any time.
