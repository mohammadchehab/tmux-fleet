# Shared Fleet Proposal: Pooled Peers on a Shared Board

**Status**: Draft for review  
**Date**: 2026-11-10  
**Authored by**: Claude Haiku (with Mohammad)  
**Audience**: Mohammad (primary), then security team

## Executive Summary

Enable two peers to pool their fleets onto a single shared board without running any server. Each person runs their own `fleetd` locally. The Backlog board syncs via git (GitHub repo or git-over-ssh). Tasks are claimed by git commit+push atomicity, eliminating the need for a lock service. No process runs on any machine except its owner's.

## Current Architecture

**Today's single-person fleet:**
- One `fleetd` process per machine
- Board: local SQLite store + git-backed Backlog.md
- PM dispatch: PM reads board, dispatches work to peers on this machine
- Remote peers: would require a server or hosted state

**Today's constraint**: Multi-person collaboration requires a central server (Backbase infrastructure) that we want to avoid.

---

## Proposed Architecture: Distributed Pooled Fleets

### 1. Claim & Lease Model (Git-Atomic)

**How a fleet claims work:**
1. `fleetd` (person A) reads current Backlog.md from git
2. Selects an unclaimed card
3. Writes `claim: claimed_by_peerId:timestamp` to the card's YAML frontmatter
4. Commits & pushes: `git commit -m "person-a: claim CARD-123" && git push`
5. If the push succeeds: card is locked to person A's peer
6. If the push fails (someone else beat them): person A pulls, re-reads, tries next card

**Why this works:**
- Git's push atomicity prevents two fleets claiming the same card
- Losers (failed push) retry on next card, no central lock service needed
- No coordination overhead

**Stale claims (laptop asleep, network down):**
- Card shows `claimed_by: peerId:2026-11-10T15:30Z`
- After 8 hours (configurable), claim is considered stale
- Another fleet can overwrite stale claims with a commit: `git commit -m "person-b: reclaim CARD-123 (stale)"`
- Original peer, when it wakes up, sees the reclaim event in the commit log
- The peer pulls, detects it was evicted, and abandons the work

**Lease timeout for work in progress:**
- Leases auto-renew every tick as long as `fleetd` is running
- Lease is refreshed with a lightweight commit if >1 hour since last touch
- On shutdown/sleep, the last commit records the lease end time

---

### 2. What Syncs vs. What Stays Local

| Component | Syncs to Git? | Notes |
|-----------|---------------|-------|
| **Backlog.md board** | ✅ Yes | Cards, claims, decisions, assignments |
| **Decisions (decision.requested)** | ✅ Yes | Stored on card as YAML, read by all fleets |
| **Event log (events table)** | ❌ No | Local SQLite, never synced |
| **Store (projections, work state)** | ❌ No | Local SQLite; rebuilt from events + board state |
| **Secrets (API keys, SSH keys)** | ❌ No | Never on git; local only |
| **Brief versions** | ✅ Yes | Stored in card frontmatter so peers see current brief |

**Key insight:** The board is the *source of truth for claims and decisions*, not the event log. Each fleet maintains its own event log and rebuilds state from events + board claims.

---

### 3. Code Collaboration Model

**Product repo (source code):**
- Standard GitHub PR workflow: all changes go through PRs
- No special changes to the daemon's work/PR dispatch
- Each person owns the fleetd running on their machine; it does NOT enforce who merges PRs
- (Today: pm dispatch checks "who holds this work", enforces peer assignment — unchanged)

**Board repo (Backlog.md + synced state):**
- Fast-forward only (no force pushes, no rebases)
- Conflict resolution: last one to push wins (git default)
- Rebuild-on-conflict: if two people push simultaneously, loser pulls and rebuilds state from the new board

**Who merges what:**
- Person A's fleetd can open/merge PRs assigned to person A (unchanged from today)
- Person B's fleetd can open/merge PRs assigned to person B (unchanged from today)
- The board records who merged it (`merged_by: peerId`)
- No authority dispute: "I merged it" is written on the board by the peer who did it

---

### 4. Card Identity: Person + Fleet + Peer

**Card representation on shared board:**

```yaml
---
id: CARD-123
status: active
reason: "review the RFC on shared fleets"
role: "reviewer"

claimed_by: person-a:peer-1:2026-11-10T19:30Z
assigned_to: person-a:peer-1
started_by: person-a:peer-1:2026-11-10T19:31Z

completed_by: person-a:peer-1:2026-11-10T20:15Z
merged_by: person-a:peer-1

decisions:
  - id: dec-abc123
    kind: approval
    state: answered
    answer: "approved"
---

Card text...
```

**Identity fields:**
- `person` (computed from peerId, e.g., "Mohammad", "Engineer-3")
- `fleet` (e.g., "Mohammad's fleet", computed from hostname or UUID)
- `peerId` (e.g., "claude", "user-cli") — the actual worker

**Why:** Humans read the board and want to know who is responsible. peerId alone is opaque. The board can display: "Mohammed's peer-1 is working on this" or just "Mohammed is working on this".

---

### 5. Conflict Resolution: Simultaneous Edits

**Scenario:** Person A and Person B both pull at the same time, both edit a card, both try to push.

**Resolution:**
1. Person A pushes first → succeeds
2. Person B tries to push → fails (out of date)
3. Person B pulls the new board
4. Person B's `fleetd` rebuilds local state from the new board
5. If Person B's changes were about a different card: person B re-applies changes and pushes again
6. If the *same card* was edited:
   - Person B's claim was lost (Person A reclaimed it)
   - Person B's edits to the card are discarded
   - Person B re-reads the card (now showing Person A's work) and lets the assigned peer handle it

**Why this works:** The board is authoritative. State is always rebuild able from the board + local events. Losing an edit to a claimed card is expected and correct — the claim determines authority.

---

### 6. Offline Behavior

**Fleetd is running but network is down:**
- Backlog.md is stale (last pulled version)
- Local event log continues to work (still processing work)
- Cards assigned to local peers can be worked (use stale board)
- New card claims fail silently (can't push)

**Fleetd wakes after 4 hours offline:**
1. Tries to pull Backlog.md
2. Merges: `git pull --ff-only origin main` (fails if non-FF history, alerts user)
3. Rebuilds state from events + new board
4. Resumes work

**Offline + laptop sleep + another fleet reclaims card:**
- Peer A sleeps, holding CARD-123
- Person B reclaims with: `git commit -m "person-b: reclaim CARD-123 (stale)"` (4+ hours passed)
- Person A wakes 6 hours later, pulls, sees the reclaim
- Person A's fleetd logs: "work/CARD-123 was reclaimed by person-b"
- Person A's peer stops that work and moves on

---

### 7. Onboarding a Second Person

**Step 1: Exchange key material (one-time)**
- Person B requests SSH public key from Person A (or both trust GitHub)
- If using git-over-ssh: Person B adds Person A's key to their server OR both push to shared GitHub repo
- If using GitHub: Person B gives Person A the GitHub repo URL; Person A forks or Person B adds Person A as a collaborator

**Step 2: Configure fleetd**
- Person B clones the shared Backlog repo (or adds remote)
- Person B's fleetd has a different hostname/fleet UUID (Person B's machine)
- Person B configures: `backlog_remote = "git@person-a-server:backlog.git"` or GitHub URL
- Person B's fleetd first pull: reads all existing cards, rebuilds state

**Step 3: Start work**
- Person B's fleetd can now claim cards, make decisions, etc.
- Person A's fleetd continues as before
- Both fleets pull/push whenever they sync

**No server, no registration, no credentials beyond git SSH key or GitHub access.**

---

### 8. Replaced & Modified Pieces

| Piece | Today | Proposed Change |
|-------|-------|-----------------|
| **PM dispatch** | Reads store, assigns to peers | Unchanged; now also reads board for claims |
| **Board sync scripts** | `git push` after editing board | `fleetd` handles it: commit + push every tick |
| **Tracker** | Web UI for shared board (needs server) | Static board.md in git; no web UI needed |
| **Remote peers** | Would need a server | Not needed; each peer runs locally |
| **Claim/lock service** | Would need a server | Git push atomicity |
| **Decision persistence** | In-process only | Stored on board as YAML, survives restart |

**Pieces unchanged:**
- Event log (local SQLite, one per fleetd)
- Provider (Claude, Cursor, DeepInfra) — no changes
- Work dispatch logic (PM rules) — no changes
- Brief versioning — no changes

---

### 9. Phased Implementation Plan

**Phase 0: Design review (this document)**
- Mohammad reviews and confirms direction
- Security team checks for attack surface
- Iterate if needed

**Phase 1: Board git sync (smallest first slice)**
- `fleetd` commits Backlog.md after each PM tick
- Pull Backlog.md at startup + on heartbeat
- Store: read board state into a new `board_state` table
- Minimal: no claim logic yet, just push/pull the file

**Phase 2: Claim & lease on board**
- Add `claimed_by` and `assigned_to` to card YAML
- PM dispatch: check board claims before assigning work
- Git-atomic push: commit claim before popping the next card
- Stale claim eviction: run every N hours

**Phase 3: Decision persistence**
- Store decision.requested / decision.answered on card as YAML
- escalate.ts, approval-gate, etc. read decisions from board
- Allows decisions to survive fleetd restart

**Phase 4: Multi-person testing**
- Onboard second person (engineer-3 or similar)
- Test simultaneous edits, claims, offline scenarios
- Document procedures

**Phase 5: Migration from single-person**
- Existing fleetd instances keep working (backward compat)
- New flag: `--shared-fleet` enables board sync
- No breaking changes to event log or provider

---

### 10. Attack Surface & Mitigations

**Git repo compromise:**
- Attacker pushes fake board with all claims reassigned
- **Mitigation**: Board is signed on push (e.g., GPG-signed commits, branch protection)
- **Mitigation**: fleetd verifies author before accepting claims from unknown peers
- Fallback: if untrusted push, alert human and require manual resolution

**Stale claim attack:**
- Attacker pushes "reclaim" for someone else's card and keeps pushing
- **Mitigation**: Reclaim only works if >N hours since last touch AND original peer hasn't pushed recently
- **Mitigation**: fleetd logs reclaims; original peer sees alert when it wakes

**SSH key compromise:**
- Attacker pushes to board repo with stolen key
- **Mitigation**: Same as git repo compromise; board is signed, changes audited

**No MITM on git (ssh or GitHub):**
- Assumed secured by TLS/SSH
- If using self-hosted git over ssh: same security as any other SSH service

---

## Questions for Mohammad

1. **Board format**: Keep Backlog.md as human-readable YAML, or switch to JSON? (YAML is more readable for git diffs)
2. **Board location**: GitHub private repo (easiest), or self-hosted git-over-ssh (more control)?
3. **Signature**: Do we need GPG-signed commits on board pushes, or is branch protection enough?
4. **Stale claim timeout**: 8 hours, 24 hours, or configurable?
5. **Conflict handling**: "last write wins" (current proposal) or require manual resolution?
6. **Offline duration**: How long can a laptop sleep before fleetd auto-abandons its leases?

---

## Next Steps

1. Mohammad reviews and confirms direction
2. Security team reviews attack surface
3. Begin Phase 1: board git sync (target: 2–3 days)
4. Parallel: engineer-3 implements ReadModel.judge (unblocks TASK-26/16)
5. Once ReadModel.judge done, escalate.ts + ready.ts use projections (Phase 3 blocker removed)
6. Shared fleet becomes viable (no judge answer lookups blocking it)
