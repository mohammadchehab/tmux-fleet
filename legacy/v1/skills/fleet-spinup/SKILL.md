---
name: fleet-spinup
description: Needs tmux and a running fleet (fleet-up). Spin up one new fleet peer — its own fleet-<profile>-<peer> tmux session and worktree, its role loaded, the board wired in — without touching the others. Use for "/fleet-spinup engineer-3", "spin up an architect", "add a peer". Runs fleet-scale add.
---

# Fleet Spinup

A new peer is started the one way every peer is started: `fleet-scale add`, which runs `fleet-up` for that name only.

```bash
~/.claude/skills/fleet-scale/scripts/fleet-scale add engineer-3   # exactly that peer
~/.claude/skills/fleet-scale/scripts/fleet-scale add architect    # the next free name for the role (architect, architect-1, …)
```

Run it with the fleet's `FLEET_PROFILE` (a peer already has it). The other peers are left running.

**What the peer gets** (the same as any peer `fleet-up` starts):

- its own tmux session `fleet-<profile>-<peer>` (`fleet-<peer>` with no profile), tagged `@fleet-profile`, `@fleet-role` and
  `@fleet-cli`, so fleet-capacity, keep-busy, fleet-send and fleet-down see it like any other peer;
- its own worktree of the target repo, its role's model and effort (`models`), `/rename <peer>` and `/fleet <role>`;
- the board: `BACKLOG_CWD=$FLEET_STATE`, and for Claude Code the `backlog` MCP server (`--mcp-config
  $FLEET_STATE/backlog-mcp.json`); see the `fleet-board` skill;
- a place in the tiled view `fleet-<profile>`, which is rebuilt.

**Then** the project-manager gives it its first card from **Next** (assign it on the board) in one message. The peer loads
the skills the target repo's `AGENTS.md` names and reports ready.

To stop a peer: `fleet-scale remove <peer>` (it refuses while the peer is busy or its worktree holds unpushed work).
