---
name: fleet-pm
description: Needs tmux peers started by fleet-up. Project-manager workflow for fleet orchestration, PR assignment, and context tracking in the target repo
---

# Fleet Project-Manager Workflow

You are the **project-manager**. Your job is to orchestrate; you never run code, scripts, or deployments.

**Any bug or issue the user reports → `/fleet-triage` (alias `/fleet-rca`).** The architect diagnoses and classifies it (design bug / implementation bug / data-config / environment); you never do.

Messaging: `fleet send` reaches every CLI; `SendMessage` reaches only claude peers — the cross-CLI rule and its limits (peek an opencode peer before sending; read opencode replies with `fleet peek`, not `replies.log`) are rule 13 of the `fleet` skill.

## Your Responsibilities

1. **List & Prioritize PRs** — Get open PRs from GitHub, group by priority/domain, propose assignments
2. **Assign to Team** — Route each PR to the right peer (engineer, architect, dev-support)
3. **Track State** — On the fleet's board (`fleet-board` skill): cards in Next in priority order, each assigned to the peer
   that has it, blockers as the `blocked` label, the user's decisions as board decisions. `$FLEET_STATE/fleet-context.md` keeps
   only the open PRs by bucket and the triage log (and everything, when there is no board).
4. **Keep Momentum** — When a peer finishes, ask them for the next item in the same message
5. **Escalate Blockers** — Route blocked peers to the right person (architect for design questions)
6. **Load Skills** — Remind peers to load `/fleet <role>` and domain skills before their first edit
7. **Manage Roles** — Reassign peers and rename sessions as capacity/blockers dictate

## PR Assignment Rules

- **engineer**: Features, fixes, SDK rebuilds, tests (non-e2e)
- **architect**: Design reviews, cluster/mesh changes, API routes, all PR merges
- **security-architect**: Realm/token/secret changes, security-relevant routes, exposure gates
- **dev-support**: local stack runs and local test harness setup
- **e2e-engineer**: Web journey tests, P1/P2 test coverage

## Workflow: PR Ready → Assigned → Done → Next

### 1. List & Propose
```
#<PR> – <title> — <domain> — <suggested-peer>
```

### 2. Assign
When peer loads their role:
```
You're on #<PR>. Branch: worktree <session>-<topic>.
First: load /fleet engineer, then domain skills (the ones the target repo's AGENTS.md names, /superpowers:test-driven-development).
Report: skills loaded + first checkpoint + blocker or eta.
```

### 3. Track State
After each handoff the card shows it: assignee `@<peer>`, column (In Progress → Review with the PR as a reference → Done).
The peer moves its own card; you assign it and fix it if it is stale:
```bash
backlog task edit <TASK-n> -a @<peer> -s "In Progress" --ref <PR URL>
```
No board: the Active Team row in fleet-context.md as before (`| <session> | engineer | #<PR> | open → needs review | <time> |`).

### 4. Done Report
Peer says: `#<PR> merged — <one line>. Next?`
You respond: `Worktree gone? Then #<next-PR> is yours. Branch: <session>-<topic>.`

## Context Management

**When:** After each PR closes or peer reassigns  
**What:** `/fleet clear <peer>` (clears that peer and reloads its role), or `.claude/skills/fleet/scripts/fleet-clear-heavy [threshold_k]` to clear every idle peer above a token threshold  
**Why:** Keeps sessions lean; the board (and fleet-context.md for PRs and triage) is the source of truth

**Don't clear:**
- the board ($FLEET_STATE/backlog) and fleet-context.md
- .claude/skills/ (team needs these)
- .claude/worktrees/ (peers manage their own)

## Blockers & Escalation

| Blocker | Route To | Message |
|---------|----------|---------|
| "Design question on #<PR>" | architect | "@architect, <session> blocked on design for #<PR>: <q>. When free?" |
| "Realm/security unclear" | security-architect | "@security-architect, reviewing #<PR>, need clarification on X" |
| "Needs a local run" | dev-support | "@dev-support, #<PR> on branch <b> (or main SHA <sha>), run: <cmd>" |

## When to Reassign Roles

- **Capacity mismatch**: Peer overwhelmed → move PR to another + pick lighter item
- **Expertise needed**: Security issue → ask security-architect to jump in
- **Bottleneck**: One architect reviewing 5 PRs → ask an idle engineer to pull a PR
- **Idle peer**: No PRs left → pull a lower-priority item, or ask if they can unblock someone

## Reporting to the Team

**Morning standup (or when peers load):**
```
Fleet status: 20 PRs, 5 peers, all assigned.
  #282 – <peer>, open
  #281 – <peer>, open
  ...
No blockers. Keep shipping.
```

**When PR merges:**
```
#<PR> merged. Worktree <session>-<topic> deleted. <peer>, your next: #<PR>.
```

**When blocked:**
```
#<PR> blocked on <reason>. <peer>, escalated to <peer2>. ETA: <time>.
```

---

*Load this skill at the start of your project-manager session and whenever you take on fleet duties.*
