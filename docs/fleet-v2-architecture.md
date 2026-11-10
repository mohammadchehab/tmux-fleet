# Fleet v2: a ground-up design

**Status:** draft for Mohammad. Decided: fully standalone `@fleet/sdk`; no fleet code ever lands in IsnadiBot, which is only the first target repo and later reimplements the ideas as E13 (§14, §14.1). Replaces the scrapped like-for-like TypeScript port (#14, #15).
**Author:** architect. **Brief:** deterministic project manager, self-purging peers, auto-wired routines, an SDK with
typed providers; tmux at most a view.

## 1. Goal and the one idea

The v1 fleet is a set of bash commands that read terminal panes and files and let an LLM peer (the project-manager)
run the loop. Every problem below follows from two facts: **state lives in places never meant to be read by code**
(panes, TSVs, `key=value` files, a status line), and **the loop lives in an expensive model**.

v2 inverts both:

> **One event-sourced store is the only source of truth. One deterministic supervisor process is the only thing that
> runs the loop. Peers are sessions behind a typed `Provider`; an LLM is consulted only through a typed question.**

Non-goals: parity with v1 commands or output text; porting any bash; keeping tmux as the control plane.

## 2. Components

```
                       ┌──────────────────────── fleetd (one process per fleet) ───────────────────────┐
 fleet CLI / board /   │  Supervisor ── PM state machine ── Scheduler (routines)                        │
 tmux view / web  ───► │      │             │                    │                                      │
   (thin clients,      │  Registry ── Mailbox ── Worktree manager ── PR gate ── Build ledger           │
    API only)          │      │             │                                                           │
                       │  ┌───┴──────── Provider interface ─────────┐        ┌── Judge (typed LLM call) ┐│
                       │  │ claude │ deepinfra │ opencode │ cursor  │        └──────────────────────────┘│
                       │  └─────────────────────────────────────────┘                                    │
                       │  Event store (append-only SQLite) + projections                                 │
                       └─────────────────────────────────────────────────────────────────────────────────┘
```

- **fleetd**: a long-lived local daemon, one per fleet profile. Owns the store, runs every loop, exposes a local API
  (Unix socket, JSON). The CLI, the board, the tmux view and any web UI are clients of that API and hold no state.
  It is started by `fleet up`; `fleet up` after a reboot resumes from the store (§8).
- **Event store**: append-only SQLite (WAL). Everything that happens is an event; every table the code reads is a
  projection rebuilt from events. Replay of a window of events reproduces every PM decision (§5.4).
- **Registry**: peers, roles, sessions, current brief version, capacity. Projection.
- **Mailbox**: the only way anything talks to a peer (§7).
- **Provider interface**: §4.
- **Supervisor**: restarts dead sessions, enforces the permission mode, maps provider events to peer state.
- **PM state machine, Scheduler, Judge**: §5 and §6.
- **Worktree manager, PR gate, Build ledger**: §9, §10, §11.
- **tmux view** (optional): `fleet view` attaches a read-only pane per peer to its provider's transcript stream. It
  never receives keystrokes from code and nothing reads it.

## 3. Data model

Event envelope: `{seq, ts, type, subject, actor, causedBy, data}`. `actor` is `pm | scheduler | peer:<id> | user |
judge:<model>`. `causedBy` links a decision to the events it was made from.

Core entities (projections), all keyed by **stable ids**, never by tmux names or session refs:

| entity | key fields |
| :- | :- |
| `Peer` | `peerId` (stable, `engineer-1`), `role`, `providerId`, `model`, `permissionMode`, `worktreeId?`, `currentSessionId`, `briefVersion` |
| `Session` | `sessionId`, `peerId`, `providerSessionRef`, `startedAt`, `endedAt?`, `endReason`. A peer has many sessions over time; the peer never changes |
| `Work` | `workId`, `title`, `state` (§5.1), `assignee?`, `contractId?`, `dependsOn[]`, `prs[]`, `external` (Jira/Backlog key) |
| `Contract` | `contractId`, `version`, `content hash`, `path in repo`. The shared interface/layout a set of Work items builds on (§12) |
| `Brief` | `briefId`, `workId`, `peerId`, `version`, `contractVersions[]`, `text`. Immutable; superseded, not edited |
| `Message` | `msgId`, `to peerId`, `from`, `kind` (`brief | answer | nudge | info`), `briefVersion`, `ack` |
| `Worktree` | `worktreeId`, `repo`, `branch`, `path`, `ownerPeerId`, `class` (active/idle/merged/gone/orphaned), `dirty`, `unpushed`, `holders[]` |
| `PR` | `repo`, `number`, `base`, `head sha`, `checks`, `review`, `stackParent?`, `workId` |
| `Build` | `repo`, `sha`, `task`, `host`, `status`, `logPath`; unique on `(repo, sha, task)` |
| `Decision` | `decisionId`, `kind`, `inputsHash`, `typedQuestion`, `typedAnswer`, `judgeModel`, `rule?`. Every PM branch is one |
| `Routine` | `routineId`, `kind`, `trigger`, `lastRun`, `state` |

The board (Backlog.md) and Jira become **sinks and sources via adapters** (`Work.external`), not the state of the
fleet. A card is created from `Work`, and a Jira change enters as an event.

## 4. Provider interface (the SDK)

Providers are the only code that knows a vendor. The interface is small and every method is typed; there is no
method that returns text meant to be parsed.

```ts
interface Provider {
  readonly id: string                                    // "claude", "deepinfra", "opencode", "cursor"
  readonly capabilities: { resume: boolean; modelSwitch: boolean; usageTokens: boolean;
                           structuredOutput: boolean; permissionModes: PermissionMode[] }
  start(spec: SessionSpec): Promise<SessionHandle>       // spec carries cwd, env, model, permissionMode, role brief, resume ref
  send(h: SessionHandle, msg: Turn): Promise<TurnId>     // a turn, never keystrokes
  interrupt(h: SessionHandle, turn?: TurnId): Promise<void>
  stop(h: SessionHandle): Promise<void>
  status(h: SessionHandle): Promise<PeerState>           // "starting"|"working"|"waiting_input"|"idle"|"ended"|"failed"
  usage(h: SessionHandle): Promise<{ contextTokens: number; contextLimit: number; costUsd?: number }>
  model(h: SessionHandle): Promise<{ id: string; endpoint?: string }>   // read from the spawned process/SDK config, never a UI string
  events(h: SessionHandle): AsyncIterable<ProviderEvent> // turn started/ended, tool use, question asked, error, compaction
  resume(ref: ProviderSessionRef, spec: SessionSpec): Promise<SessionHandle>
}
```

- **`waiting_input`** is a provider event ("the model asked the user a question"), not a regex on `?`. That replaces
  the `asking` guess.
- **Permission mode and env are part of `SessionSpec`**, validated by the supervisor against the peer's declared
  mode before `start`. A session that comes up in another mode is stopped and restarted, not tolerated (§13).
- **Implementations:**
  - `claude`: the Claude Agent SDK (preferred; gives events, usage, resume and structured output), falling back to
    spawning the CLI with `--output-format stream-json`.
  - `deepinfra`: the same Claude implementation with `ANTHROPIC_BASE_URL`/key/model set in `SessionSpec.env` of
    *that one process*. No shared tmux server seeds env, so there is no drift.
  - `opencode`: its server/SDK mode (`opencode serve`) rather than a pane.
  - `cursor`: Cursor's headless agent with `--resume <chatId>`; if it exposes no usage, `capabilities.usageTokens =
    false` and the self-purge trigger falls back to turn count (§6).
- A provider that cannot do something says so in `capabilities`; the supervisor adapts, it does not guess.

## 5. The deterministic project manager

### 5.1 Work state machine

`proposed → needs_contract → ready → assigned → in_progress → in_review → mergeable → merged → cleaned`, plus
`blocked(reason)` and `cancelled`. Transitions are pure functions of events; the PM only appends the event that
causes them.

### 5.2 The loop

One tick runs on any event (not a timer poll) and on a heartbeat. Each tick is a pure function
`decide(state, event) → Action[]`; actions are executed afterwards and their results become events.

| rule | trigger | action |
| :- | :- | :- |
| assign | peer `idle` ∧ `Work` `ready` for its role ∧ under the PR cap | write `Brief` v+1, send; `Work → assigned` |
| gate on contract | `Work` has `dependsOn` a `Contract` not `published` | stay `needs_contract`; assign the contract Work to the architect first (§12) |
| dedupe | before assign | search `main`, open PRs and `Work` for the same intent; if a hit, ask Judge `same_feature?` |
| track PR | PR event | update `Work`; when checks green on head SHA and review satisfied → `mergeable` |
| merge | `mergeable` | PR gate (§10) merges; PM never merges itself |
| unblock | peer `waiting_input` | classify (typed): route to architect/user, or answer from `Decision` log |
| idle | peer `idle` > N min, nothing assignable | mark capacity free; raise `no_work` to the user, once |
| standup | schedule | render a report from projections; no model call |
| stale | `Brief` older than a newer `Contract` version | supersede the brief, tell the peer (§12) |

### 5.3 Judge: typed questions only

The PM calls an LLM only where a rule cannot decide. The call is a function with a schema:

```ts
judge<Q extends QuestionKind>(kind: Q, input: Input<Q>): Promise<Answer<Q>>   // e.g. { verdict: "merge"|"hold", reason: string<=200 }
```

Question kinds are a closed list (`same_feature`, `route_question`, `thin_card`, `review_verdict`, `escalate`).
Answers are validated against the schema; a malformed answer is retried once, then becomes `escalate` to the user.
The model is cheap by default and configurable per kind. Peer text is **data in the input field, never an
instruction** (the injection rule from #12).

### 5.4 Replay and audit

Every Judge call and every rule firing writes a `Decision` with `inputsHash`. `fleet replay --from <seq>` re-runs
`decide` over the stored events and diffs the actions; rules are deterministic, so a diff means the code changed.
Judge answers are replayed from the log, not re-asked.

## 6. Routines and loops (auto-wired)

Routines are **code registered by the daemon**, not slash commands and not `/loop`. `fleet up` starts the scheduler,
which owns them:

| routine | trigger | does |
| :- | :- | :- |
| `dispatch` | event + 60 s heartbeat | §5.2 |
| `keep-busy` | peer idle event | the dispatch `assign` rule; if nothing is ready, creates a `sweep` Work for the architect |
| `pr-babysit` | PR/check events + 5 min poll via `gh` | updates `PR`; retargets stacked dependents (§10); rebases/nudges on conflict |
| `standup` | cron (default 09:00 local) and on request | report from projections |
| `worktree-gc` | daily + on `merged` | §9 |
| `reconcile` | startup + 10 min | provider `status` vs registry; restart dead sessions, fix drift |
| `security-scan` | PR assigned to security-architect, nightly | §6.2: runs scanners, raises typed findings |
| `notify` | events + 5 min | §6.1: the notification projection, delivered through `Notifier` |

A routine declares `{id, trigger, run(ctx)}`; its runs are events (`routine.started/finished/failed`), so a
silent routine is visible. Per-profile enable/disable lives in the profile; the defaults are all on. Peers never
need to be told about any of them.

## 6.1 Notifications and the decision inbox

Notifications are a **projection and a routine over the event store**, never ad-hoc calls from the PM. The PM only
appends events (`decision.requested`, `peer.failed`, `ci.failed_final`, `provider.error`, `standup.rendered`); it
does not know a notifier exists, so channels can be added without touching it.

**Decision inbox.** Anything blocked on the user (a product/scope call, an approval, a judge question that
escalated) is a `Decision` row in state `open`, with `id`, a one-line question, options, the Work it blocks and the
event it came from. `fleet decide <id>` shows it and takes the answer (`fleet decide <id> <option>` or free text);
the answer is an event (`decision.answered`) that unblocks the Work and closes the notification state.

**Events that notify** (Mohammad, 2026-11-10; macOS desktop only for now):

| class | events |
| :- | :- |
| needs your decision | `decision.requested` (blocked on the user, escalated judge question, approval needed) |
| failure | peer crash, a session that will not resume, CI red after retries, provider/auth/budget error |
| standup | the daily standup summary |

**Not notified:** PR ready to merge (the PR gate acts on it, §10), peer idle, routine runs, purges.

**Notifier interface.**

```ts
interface Notifier {
  readonly id: string                                        // "macos"
  notify(n: Notification): Promise<{ delivered: boolean }>   // {key, class, title, body, action: {cmd: "fleet decide <id>"}}
  withdraw?(key: string): Promise<void>                      // clear a delivered one when its decision closes
}
```

`macos` is the first implementation (`terminal-notifier` if present, else `osascript display notification`; the
action opens a terminal running `fleet decide <id>`). Phone or Slack later are more `Notifier`s registered in the
profile; routing by class is profile config.

**Notification state** is a projection keyed by `key` (`decision:<id>`, `failure:<subject>:<kind>`,
`standup:<date>`): `pending → sent → resolved`. Rules, all pure functions of events and the clock:
- **Dedupe:** one notification per key. A decision notifies once when opened.
- **Failure rate limit:** a failure key notifies once, then is suppressed until it resolves or a 6 h window passes with
  a count appended ("still failing, 4 events"), never one per retry.
- **Still waiting:** an open decision gets at most one quiet reminder after N hours (default 8), then none.
- **Close:** `decision.answered`, or the failure's recovery event, moves the key to `resolved` and calls `withdraw`.
- **Delivery failure** is an event (`notify.failed`); the decision stays visible in `fleet ls` and `fleet decide`, so a
  missed banner loses nothing.

The `notify` routine (§6) runs on events and a 5 min heartbeat; its runs are events like any routine's, and it replays
deterministically. **It lands in phase 1**: the decision inbox is how the deterministic PM escalates to the user.

## 6.2 Security scanning and codegraph, enforced by mechanism

### Scanners (security-architect routine)

The security-architect stops hunting by reading code. A `security-scan` routine runs real tools, on every PR the
security-architect is asked to review (on the PR head SHA) and nightly on `main`. Tools are chosen by signal per
cost and by what the target repo contains; each is a `Scanner` adapter that emits typed findings.

| tool | covers | why this one | when |
| :- | :- | :- | :- |
| **semgrep** | SAST: injection, authz mistakes, unsafe sinks, project rules | fast, offline rules, custom rules per repo, JSON/SARIF output | every PR + nightly |
| **gitleaks** | secrets in the diff and history | purpose-built, low false positives, runs on the diff in seconds | every PR (diff) + nightly (history) |
| **osv-scanner** | known-vulnerable dependencies from lockfiles (pnpm-lock, go.sum, …) | one tool for all ecosystems, uses the OSV database; `pnpm audit` adds nothing the lockfile scan misses | every PR that touches a lockfile + nightly |
| **trivy (config/fs)** | IaC and container misconfig, image CVEs | only where the repo has Dockerfiles, `deploy/` or `infra/` | PRs touching those paths + nightly |
| **claude-security scan skill** | deep, model-driven review: logic flaws a rule cannot express | expensive, so **not per PR**: nightly on `main`, and on a PR flagged security-relevant by path (identity, gateway, tokens, secrets, egress) | scheduled + flagged PRs |

Not chosen: CodeQL (heavier setup, GitHub-side), `npm audit` alone (npm-only), running every tool on every PR (cost
and noise). A scanner that is absent is skipped and recorded (`scan.skipped`), never silently.

**Findings are typed events.** `finding.raised {tool, ruleId, severity, path, line, fingerprint, message, sha}`,
where `fingerprint = hash(ruleId + path + normalized snippet)`, so a finding survives line shifts and is **deduped by
rule + location**; a re-run that sees the same fingerprint appends `finding.seen`, not a new finding. The `Finding`
projection holds `open | confirmed | dismissed | fixed` with the decision that moved it.

**From finding to work, to a decision:**
1. `finding.raised` is routed by the PM as a rule, not by an LLM: severity LOW/INFO stays in the projection; MED and
   up becomes a `security-verify` Work for the security-architect with the finding attached.
2. The security-architect **reads only the cited code** (through codegraph, below) to verify, and answers a typed
   `finding.verdict {confirmed | dismissed, reason}`. A dismissal needs a reason and is remembered by fingerprint.
3. `confirmed` creates a fix Work: MED gets a ticket and enters the queue; HIGH is assigned to an engineer at once
   (fleet rule 7).
4. A `confirmed` **critical** (profile-defined: severity critical, or a secret in a pushed branch, or an exploitable
   path to a gateway/identity/token surface) additionally appends `decision.requested`, which the notification
   projection (§6.1) turns into a "needs decision" notification. Leaked secrets also create a rotation Work at once.
5. A PR is not blocked by findings the security-architect has not yet verified (fleet rule 7); a confirmed critical
   blocks the PR gate (§10) for that PR.

### Codegraph, enforced

"Use codegraph first" is a mechanism in the session wrapper, not a prompt line. For every session of every peer:

1. **Index:** before `startSession`, the supervisor runs `codegraph-ensure` for the peer's worktree (installs the CLI
   and indexes if missing; fast no-op otherwise) and emits `index.ready {worktreeId, symbols, ageSec}`; a stale index is
   refreshed at turn start after the peer's commits.
2. **Tool:** the wrapper wires the codegraph MCP server (`codegraph_explore`) into `SessionSpec.mcp` for providers
   that take MCP, and the `codegraph explore` CLI path for those that do not.
3. **Guard:** a `PreToolUse` hook (Claude Agent SDK / CLI hooks; an equivalent filter in the provider adapter where a
   provider has no hooks) inspects `Grep`, `Glob` and `Read`. When an index exists for the cwd and the call is a broad
   sweep (a Grep/Glob without a narrow path, or a Read of a file when no `codegraph_explore` has run this turn for that
   area), it **redirects**: the hook returns a message telling the model to call `codegraph_explore` with the query,
   once per turn; the second identical attempt is allowed and logged. A narrow Read of a known file for edit is always
   allowed. Mode is `enforce | warn | off` per role in the profile; the security-architect is `enforce`.
4. **Measure:** each turn appends `turn.usage {peerId, in, out, cached, toolCalls: {grep, glob, read, codegraph}}`
   from the provider's `usage()`. The `token-report` projection gives, per peer and role, tokens per Work item, the
   share of exploration done through codegraph, and redirect counts. Baseline: run a fixed set of tasks with the guard
   `off` then `enforce`; the stated target is a measured drop in tokens per completed Work item, reported, not assumed.

Failure modes: if `codegraph-ensure` fails, the session starts without the guard and `index.failed` is raised as a
failure notification, since an unindexed peer silently costs more.

## 7. Messaging and identity

- **A peer is an id, not a session.** `engineer-1` is `peerId`; sessions come and go beneath it. Messages are
  addressed to `peerId` and stored in the Mailbox with `ack`. If the peer has no live session, the supervisor starts
  one (resume) and then delivers; nothing is sent to a dead socket. The `[eb76a6] → [569937] → [97d794]` renames
  cannot happen because nothing outside the registry ever sees a session ref.
- **Delivery is a provider call** (`send` as a turn, or injected at the next turn boundary), not keystrokes, so it
  works for every provider and cannot be held by a permission prompt (§13).
- **Messages carry `briefVersion`.** A peer's context begins every turn with "current brief: vN" resolved from the
  store by the provider adapter (system prompt / first user turn). A reply or status that cites an older version is
  rejected by the Mailbox with the newer brief attached.
- **Peer-to-peer** goes through the Mailbox too (one API), so it is logged and subject to the same identity rules.

## 8. Self-purge (the peer manages its own context)

No PM, loop or routine is involved. The lifecycle is inside the peer's **session wrapper**, which the provider adapter
runs around every session:

```
working ──(turn ends, usage.contextTokens > limit)──► saving
saving  ── adapter asks the peer: "write your state file" (typed: StateFile schema, required fields) ──► saved
saved   ── provider.stop; provider.start(fresh session, brief vN + StateFile) ──► working
```

- The trigger is the **provider's `usage()`** at a turn boundary, not a hook reading a transcript.
- The state file is a typed object (`goal`, `done`, `in_flight`, `next`, `decisions`, `open_questions`, `briefVersion`),
  stored as an event and also written to `<state>/peers/<peerId>/state.md` for humans. It is the single handoff.
- The new session starts from `role + current brief + the latest StateFile`, so the "status written before reading
  newer messages" bug is closed: the brief is re-resolved at start (§7), and any Mailbox messages newer than the state
  file are replayed in order.
- A purge failure (the peer wrote nothing valid after two asks) falls back to a mechanical summary from events
  (assigned work, PRs, branch state) and logs `purge.degraded`.
- Providers with no `usageTokens` purge by turn count and by wall-clock.
- Compaction events are logged; the limit is per provider/model, because a 1M-window model and a 200k one differ.

## 9. Worktree lifecycle

The Worktree manager is the only thing that creates or deletes worktrees; peers ask the API (`worktree.create`).

- **Create**: under the repo's own `.claude/worktrees/<topic>`, owner recorded at creation (event, not an owner file).
- **Track**: class is computed from git/gh facts on events, not scanned on demand.
- **Holders**: processes whose cwd is inside it (lsof) are recorded; `gc` reports them and never kills them, and
  raises a user-visible item after N days (the stray Electron dev process case).
- **GC**: on `Work → merged` the manager removes the worktree and branch if clean and pushed; a dirty/unpushed one
  becomes a `Work` ("PR or drop?") assigned to its owner, then to the user. Nothing is deleted with local-only work.
  A disk budget alarms before 14 GB happens again.
- **Skill link**: `fleet up` checks that the live skill/CLI link points at the fleet's own checkout and refuses to
  start on a spike worktree.

## 10. PR gate and stacking

- The gate is code: it merges only when checks are green on the **current head SHA**, the required review is
  present (role `pr-architect`, or the human policy in the profile when none runs), and the PR has no unmerged stack
  parent.
- **Stacks are first-class**: `PR.stackParent`. Before merging a parent, the gate retargets every dependent to the
  parent's base and **never passes `--delete-branch` while a dependent exists** (the #102 loss).
- Merge ownership is a profile policy the gate enforces; with no reviewer role running the gate asks the user, it does
  not stall silently.

## 11. Build ledger and remote runs

`Build(repo, sha, task)` is unique. A peer requests a build through the API; the ledger returns the existing result
or runs it once. Heavy tasks route to the remote host (hetzner) by task class in the profile; light ones run locally.
The same SHA+task never runs twice and results are shared by all peers.

## 12. Contracts before work

A `Work` that depends on shared structure declares `contractId`. The PM does not assign it until that `Contract`
(a spec file merged in the repo, hashed) is `published`. Contract work is itself a `Work` assigned first, small and
fast-merged (the §2.1-style rules of the port plan become a contract). A new contract version supersedes dependent
briefs (§5.2 `stale`), so two peers cannot build on different layouts, and the foundation stops being a surprise
serial blocker because the PM sees it as a dependency edge and parallelises everything behind the contract.

## 13. Problems → solutions

| problem | how v2 solves it |
| :- | :- |
| PM as an LLM peer: expensive, nondeterministic, idles | PM is code (§5); LLM only for typed `judge` calls on a cheap model; no PM context to grow or drift |
| pane-scraped busy/idle/asking | `Provider.status` and `events` (`waiting_input` is an event) |
| TSV caches by column, roster `key=value` | typed projections in SQLite with schemas |
| unstable peer identity, messages to dead sessions | stable `peerId`; sessions are children; Mailbox resumes before delivery |
| messages held for approval, wrong permission mode | `permissionMode` is in `SessionSpec`, validated; delivery is a provider call, not keystrokes; mismatch ⇒ restart |
| provider/env drift, `FLEET_TMUX` ordering, model guessed | env per `SessionSpec`, one process per peer; `Provider.model` reads the real config; no profile-before-source ordering exists |
| stale instructions, no single brief/contract | versioned `Brief` and `Contract`, resolved at every session start, superseded on change (§7, §12) |
| work starts before the contract | `needs_contract` gate (§12) |
| worktree sprawl, orphans, stray holders, live link on a spike | §9: owner at creation, GC on merge, holder tracking, link check |
| stacked-merge branch loss | §10: retarget before merge, no `--delete-branch` with dependents |
| merge ownership gap | §10: gate in code, owner policy in profile, asks user if none |
| duplicate builds | §11 ledger, unique `(repo, sha, task)`; heavy on hetzner |
| idle peers, unknown capacity | `keep-busy` on idle events; capacity is a projection |
| duplicate features | `dedupe` rule before assign (§5.2) and in every brief |
| self-purge | §8, inside the session wrapper, no PM/loop |
| the user finds out late, or is spammed | §6.1: decision inbox + `Notifier` (macOS first); notify only on decisions, final failures and the daily standup, deduped and rate-limited; `fleet decide <id>` answers and closes it |
| the security architect hunts by reading code | §6.2: semgrep, gitleaks, osv-scanner (+trivy where it applies, claude-security scan nightly); findings are typed, deduped events; a peer only verifies |
| peers burn tokens grepping | §6.2: codegraph wired and indexed by the session wrapper, a PreToolUse guard redirects broad sweeps, per-peer token usage measured |
| routines typed by hand | §6, started by `fleetd` |

## 14. Decision: standalone, no code into IsnadiBot

**Decided (Mohammad, 2026-11-10): fully standalone, and no fleet code ever lands in IsnadiBot.** In his words: "code
we build should not land in the isnadi-bot, just the idea."

- `@fleet/sdk` and `fleetd` live in tmux-fleet: store, provider runtime, PM loop, self-purge, status, standup, plus the
  fleet-only pieces (merge gate, worktree manager, build ledger, scanners, codegraph guard, contract gating).
- **No dependency on IsnadiBot at runtime or at build time**, no pinned IsnadiBot bootstrapping, no shared package, no
  adapter over its provider drivers. IsnadiBot is the first target repo the fleet builds, nothing more.
- IsnadiBot implements the proven *ideas* later, as E13, in its own codebase and stack (Effect, its contracts).
  Nothing from this repo is ported or merged there. §14.1 is the idea map that hand-off is made of.
- Rejected, for the record: building the overlap inside IsnadiBot (dogfooding E13). It would couple the tool that
  builds the product to the product's release train and make "standalone" mean "needs an IsnadiBot environment".
  Also rejected: sharing a provider package with IsnadiBot, and shaping `Provider` to IsnadiBot's contract.

Consequence: the §4 `Provider` interface is designed purely for the fleet's needs. Vocabulary may match IsnadiBot's
where that reads naturally (bot, provider, turn, routine, work item, handoff), but it is not a constraint.

## 14.1 Idea map for IsnadiBot (E13)

Not a port plan. This records which behaviours the fleet proves, what E13 should take from them, and what the fleet
learned the hard way. Read from IsnadiBot's docs and `origin/main` (`docs/internals/glossary.md`,
`fleet-operations.md`, `delegation.md`, `apps/server/src/{orchestration,provider,routines}`), not from memory.

**Where E13 stands (`origin/main`).** Built: the work-item aggregate and projection (TASK-87 PR1, #146), the role
library and fleet templates (TASK-92, #143). Designed in `fleet-operations.md` and not built: the dispatcher
(TASK-86), handoff and context epoch (TASK-84), auto-clear (TASK-85), bot status (TASK-83), standup (TASK-88), PR
queue (TASK-89), scale (TASK-90), triage (TASK-91). The fleet builds its own version of these, independently, and
reports what it learned.

| behaviour the fleet proves | E13 counterpart | what E13 should take | gap in E13 |
| :- | :- | :- | :- |
| dispatcher as a pure `decide(state, event)`; LLM only for typed judgement | TASK-86 dispatcher, boss wake | the rule table (§5.2), a **closed list of typed judge questions** instead of free boss wakes, and logging every decision with inputs for replay | typed questions and replay not in the spec |
| self-purge inside the session wrapper, triggered by provider usage at a turn boundary | TASK-84/85 handoff + context epoch | the trigger point (turn end, idle only), a **typed state file** with required fields, replaying newer messages after the reset, the degraded fallback when the peer writes nothing valid | the spec has no failure path |
| bot status from provider events (`waiting_input` is an event) | TASK-83 busy/asking/held/idle | derive `asking` from an event, never from text; same four words work | none |
| decision inbox + notifications with dedupe, rate limit, one still-waiting reminder, `fleet decide`-style answer closing the state | Decisions group, bot inbox, push | the notification-state machine (§6.1) and its three classes | no escalation routing from the dispatcher |
| stable identity: peer id outlives sessions; mailbox resumes before delivery | durable bots/threads | message-to-id with resume-then-deliver; no session handle leaks to callers | no brief versioning |
| versioned briefs and contracts, `needs_contract` gate | item `brief` | brief version carried into each turn; reject stale replies; do not assign dependents before the shared contract is published | none |
| PR gate: green on current head SHA, no `--delete-branch` with dependents, retarget stacks first | PR queue is read-only | the gate rules (§10) | no merge or stack handling |
| worktree manager: owner at creation, GC on merge, holder tracking, never delete local-only work | thread `worktreePath`, `workspace-layout.md` | the lifecycle (§9) | no ownership or GC found in the docs read |
| build ledger unique on `(repo, sha, task)`, remote for heavy tasks | none found | the idea | gap |
| scanner routine with typed, fingerprint-deduped findings; peers verify, not hunt (§6.2) | none in product code | the finding lifecycle and the routing to work items and decisions | gap |
| codegraph wired and indexed per session, PreToolUse redirect, per-turn token measurement (§6.2) | skills registry (E14), MCP server; no equivalent found | enforce by mechanism, and measure | gap |
| event-triggered routines (not only scheduled) | routines are schedule-centred | event triggers plus heartbeat | gap |

### Lessons, to be filled in as the fleet runs

This list starts with what is already known and grows from real runs; each item says what E13 should do differently.

1. **Receipts are test-only in IsnadiBot production** (`RuntimeReceiptBus` publishes nothing outside tests). The
   fleet builds no control flow on receipts; it uses events. A lesson for the fleet's design: observability signals
   and control signals are different things.
2. Pane scraping, text-regex state and ad hoc caches were the root of v1's drift; every state is a typed event.
3. Context purge needs a failure path, because peers sometimes write nothing usable.
4. A shared contract must exist before parallel work starts, or peers invent conventions.
5. Merge ownership must be explicit; a gate with no reviewer role should ask the user, not stall.

### Vocabulary

Matching IsnadiBot's words where natural (bot/peer, provider, turn, routine, work item, handoff, decider/reactor)
keeps the later hand-off of ideas cheap. It is a courtesy, not a constraint, and nothing is contract-compatible by
requirement.

## 15. Phased build plan

Each phase is shippable and leaves a working fleet. v1 keeps running untouched until phase 3 replaces it.

**Phase 0: contracts (days, architect + 1 engineer).** `Provider`, event schema, projection schemas, `SessionSpec`,
Mailbox API as typed files and golden tests. Merged first, small. Everything below builds on it (§12).

**Phase 1: the vertical slice (the usable fleet).**
`fleetd` + SQLite event store + Registry; **one provider (`claude`, with `deepinfra` as env config)**; Supervisor
(start, resume, restart, permission-mode check); Mailbox with stable ids; the PM state machine with `assign`, `track
PR`, `merge` gate and `standup`; Scheduler with `dispatch`, `keep-busy`, `pr-babysit`, `reconcile`, `notify`; the decision inbox, `fleet decide` and the macOS `Notifier` (§6.1); **self-purge**
(§8); `fleet up/down/ls/send/peek` as API clients; Judge with `route_question` and `same_feature`. No board sync, no
worktree GC, no remote builds yet. Exit test: a squad of one architect and two engineers takes three Work items from
`ready` to `merged` in a sandbox repo with no human and no PM peer, survives killing a peer session mid-turn, and
purges and resumes one engineer at its limit.

**Phase 2: hygiene.** Worktree manager and GC; holder tracking; PR stacking/retarget; Build ledger and the hetzner
runner; contract gating (§12); replay tool.

**Phase 3: providers and sinks.** `opencode` and `cursor` providers; the Backlog/Jira adapters; tmux view; a web
board on the daemon API; cut over from v1, delete the bash.

**Phase 4: hand the ideas to IsnadiBot.** The lessons and measured results go into the E13 idea map (§14.1). No code is ported.

## 16. Risks

- **Agent SDK coverage.** If a provider cannot report usage or waiting-input, its purge and unblock quality degrade;
  `capabilities` makes that explicit and the fallback is turn count. Spike this first for `claude` and `deepinfra`.
- **Long-lived daemon.** A crashed `fleetd` must be resumable from the store; the supervisor starts idempotently and
  reconciles. The daemon is the new single point of failure and needs its own health check and log.
- **Judge on a cheap model** can be wrong; the closed question list and `escalate` bound the damage, and the log
  makes it reviewable.
- **Scope.** This is a rewrite. The mitigation is phase 1's single provider and its hard exit test.
