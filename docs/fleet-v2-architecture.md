# Fleet v2: a ground-up design

**Status:** draft for Mohammad. Decided: standalone `@fleet/sdk`; IsnadiBot is the first target repo (§14). Replaces the scrapped like-for-like TypeScript port (#14, #15).
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
| routines typed by hand | §6, started by `fleetd` |

## 14. Decision: standalone vs build on IsnadiBot

Read: IsnadiBot has `ProviderAdapter` (start/send/interrupt/respond/stop/streamEvents), drivers for Claude, Codex,
Cursor, Grok, Kimi, OpenCode and a custom OpenAI driver, an event-sourced `orchestration` (decider/projector),
routines and delegation. That is most of §4 and §5.4 already built, and the memory says the fleet already runs on
this repo's tooling.

Against building on it: it is a large Effect-TS monorepo (web, desktop, mobile, server) whose provider contract is
**chat-product shaped** (threads, approvals, user-input responses, checkpoints, rollback) and whose coupling to the
product's database, auth and UI is deep. The fleet needs a small daemon that a repo-level CLI user can install with
Node alone, shipping in tmux-fleet where the fleet already lives. Tying fleet releases to the app's, and tying the
fleet's correctness to Effect services and the app's persistence, repeats the very coupling v1 had to bash. I also
have not verified that its Claude driver covers a DeepInfra-pointed Anthropic endpoint or exposes context usage.

**Decided (Mohammad, 2026-11-10): standalone.** The fleet is a standalone tool that builds IsnadiBot; it does not ship inside the product. IsnadiBot is the first target repo, not a dependency. `@fleet/sdk` lives in tmux-fleet as recommended below.

**Recommendation (adopted): standalone, with a deliberate seam.**
1. Build `fleetd` and the `Provider` interface (§4) in tmux-fleet as a **separate, dependency-light TypeScript
   package** (`@fleet/sdk`), with no Effect and no app code.
2. Shape `Provider` to be a **subset of IsnadiBot's `ProviderAdapterShape`** (same verbs, same event kinds) so an
   adapter that wraps IsnadiBot's drivers is a thin file. IsnadiBot can then be *a provider source* for the fleet, or the
   fleet a provider consumer inside IsnadiBot's routines, later, without a rewrite.
3. Reuse by reading, not importing: lift the Claude driver's session/resume handling and the decider's event
   discipline as references.
4. Revisit after phase 2: if the SDK has grown a second copy of what IsnadiBot's providers do, extract the shared
   package then. Doing it first blocks the fleet behind the app's release train.

**Open question resolved:** the fleet is a standalone tool, not part of IsnadiBot's product (see Decided above).

## 14.1 Path into IsnadiBot

The fleet stays standalone for now, but its concepts are meant to become IsnadiBot product features. The fleet is the
proving ground. Filled from IsnadiBot's code and docs (`docs/internals/glossary.md`, `fleet-operations.md`,
`delegation.md`, `apps/server/src/{orchestration,provider,routines}`), not from memory.

**Finding that changes the plan.** IsnadiBot already has a design for much of this: **E13 fleet operations**
(`docs/internals/fleet-operations.md`, TASK-83..92): work items, a server-side `FleetDispatcherReactor` (Keep busy),
`handoff` plus `thread.context.reset` (context epoch), auto-clear at 150k tokens, bot status
(busy/asking/held/idle), standup routine, PR queue, scale, triage, role library. It describes itself as the native
version of these `/fleet` skills. So the fleet's job is to prove the *behaviour* (the rules, the thresholds, the
failure modes) while IsnadiBot's E13 is the destination for the *code*. Where E13 exists, the fleet must not invent
a different shape.

### Concept map

| fleet v2 concept | IsnadiBot equivalent (verified) | gap / note |
| :- | :- | :- |
| peer | **Bot** in a **Group** with `bossBotId`; role from the role library (TASK-92) | the fleet's `peerId` = `botId`; role names match |
| session | provider session on a **Thread** (`ProviderSession`, `ProviderSessionDirectory`) | fleet `Session` is a child of the peer; IsnadiBot's thread is the durable record and the provider session its runtime |
| brief / turn | **Turn** (`thread.turn.start`); item `brief` | fleet `Brief` versioning has no equivalent; IsnadiBot has the item's brief, not versions or contract gating |
| Work | **Work item** aggregate (`queued/assigned/in-progress/review/blocked/done`, `trackerLink`, `prUrl`) | fleet adds `needs_contract`, `mergeable`, `merged`, `cleaned`; map extra states to `blocked` + reason or propose them |
| PM `decide()` | **Decider** (`orchestration/decider.ts`: commands + state to events) and `FleetDispatcherReactor` | match the split: pure decide, reactor executes. The dispatcher is "plain code assigns; boss woken only for judgement", the same rule as §5 |
| Judge (typed question) | the **boss bot wake** (a judgement call) | fleet's typed closed question list is stricter; candidate to adopt in IsnadiBot |
| routines | **Routines** (`apps/server/src/routines`, `schedule.ts`, runtime/repository) | fleet routines are event-triggered as well as scheduled; IsnadiBot routines are schedule-centred. Event triggers are a gap |
| assign / delegate | **Delegation** (`SendToAgent`, child thread, handle returned, result acknowledged exactly once) and the dispatcher's assign | delegation is one running child turn with a waiter, not a queue (E13 says so); the fleet's `assign` maps to the dispatcher, not to delegation |
| decision inbox | **Decisions** roster group: `hasPendingApprovals` / `hasPendingUserInput`, memory approvals, bot inbox | the fleet's `Decision` is wider (scope calls, escalated judge questions); fits as a new approval kind |
| notifications | the **bot inbox and push** ("the owner is told through the bot inbox and push"); channels (Telegram/Slack/…) | macOS-desktop `Notifier` has no direct equivalent; push and channels are the later `Notifier`s. Dedupe/rate-limit rules are a candidate |
| self-purge | **`handoff` tool + `thread.context.reset` (context epoch)** + auto-clear at `usedTokens` over limit | *exists in E13.* Fleet's typed `StateFile` ≈ the `handoff({item, branch, done, nextStep, waitingOn, doNot})` doc; align the fields |
| event store | **Orchestration event store + projections** (`Domain Event`, `projector`, `ProjectionPipeline`, read model) | the fleet's SQLite store is the same pattern; keep event and aggregate naming compatible |
| standup | built-in **standup routine** (TASK-88) | same |
| capacity / peer status | **Bot status** busy/asking/held/idle (TASK-83), derived in `client-runtime` | same four words; fleet derives them server-side from provider events |
| PR gate, PR queue | **PR queue** (TASK-89, read-only, sorted by who acts next) | IsnadiBot has no merge gate, no stack retarget; **fleet-only for now, future feature** |
| worktree manager | thread `worktreePath` and workspace root; `workspace-layout.md` | no owner/GC/holder tracking found in the docs read; **future IsnadiBot feature** |
| build ledger | none found | **future IsnadiBot feature** |
| silent/failed session handling | **Silence watchdog** (reports, never interrupts) | fleet's `reconcile` restart-and-resume goes beyond it |
| Provider | **`ProviderAdapterShape`** (`startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `respondToUserInput`, `stopSession`, `listSessions`, `readThread`, `streamEvents`, `capabilities`) | §4 is a subset; see below |

### Rules for fleet code so the move is a port

1. **Use IsnadiBot's words** in types, events and docs: *bot* (alias `peer` only in CLI text), *group*, *provider*,
   *thread*, *turn*, *work item*, *routine*, *delegation*, *handoff*, *context epoch*, *decider*, *projector*,
   *reactor*, *read model*, *command*, *domain event*. No second vocabulary.
2. **Mirror the decider/projector split.** `decide(state, command) → events` is pure; a projector applies events to
   the read model; a **reactor** does the side effect. The PM state machine (§5) is a decider plus a dispatcher
   reactor; the scheduler and notifier are reactors. Command and event names follow IsnadiBot's dotted form
   (`work-item.assign`, `thread.context.reset`, `fleet.dispatch.decided`).
3. **Receipts are not production behaviour in IsnadiBot** (`RuntimeReceiptBus` publishes nothing in production; it
   is test-only). The fleet does not build control flow on receipts; it uses events. A receipt-shaped name
   (`fleet.dispatch.decided`) is kept only as a test/observability signal.
4. **Rename where §4 and IsnadiBot differ.** `Provider.send` → `sendTurn`, `interrupt` → `interruptTurn`, `stop` →
   `stopSession`, `start` → `startSession`; `events()` is `streamEvents`. Add `status/usage/model` as the fleet's
   extension methods, clearly marked (below).

### What must stay contract-compatible

- **The `Provider` subset of `ProviderAdapterShape`:** `startSession`, `sendTurn`, `interruptTurn`, `stopSession`,
  `listSessions`, `streamEvents`, and `capabilities`, with the same input and output field names and the same
  `ProviderRuntimeEvent` kinds. This is the seam §14 promised: an adapter over IsnadiBot's drivers is a thin file.
  Extension methods the fleet adds (`status`, `usage`, `model`, `resume` ref) are optional and map to IsnadiBot's
  `context-window.updated` activity (`usedTokens`/`maxTokens`) and session status.
- **Event and aggregate names** for work items, threads, turns, handoff and context reset, so the store's events can
  be imported into IsnadiBot's orchestration store.
- **The work-item shape** `{id, groupId, title, brief, kind, role?, ownerBotId?, state, trackerLink?, threadId?,
  prUrl?}` and the four bot-status words.
- **The handoff doc fields** (`item, branch, done, nextStep, waitingOn, doNot`) as the superset core of the
  `StateFile`.

### Fleet-only and disposable

`fleetd` as a process, the Unix-socket API, the SQLite file layout, the `fleet` CLI, the macOS notifier, the tmux
view, the Backlog.md/Jira adapters, the hetzner build runner, and the repo-local worktree manager. They exist to run
the fleet *outside* a product; when the behaviour moves into IsnadiBot they are replaced by its server, roster UI,
inbox/push and workspace layer.

### Future IsnadiBot features the fleet proves first

Worktree ownership, GC and holder tracking; the PR merge gate with stack retargeting; the build ledger with remote
runs; contract gating and brief versioning; event-triggered routines; typed judge questions; notification
dedupe/rate-limit with a `fleet decide`-style answer path. Each lands in the fleet with a measured result, then is
proposed to IsnadiBot as a TASK under E13 or a sibling epic.

### Consequence for the phases

Phase 0 gains one item: **align the contract files with IsnadiBot's names** (§ above) and write the concept map into the
repo so engineers read it before naming anything. Phase 4 (§15) changes from "decide the seam" to "port the proven
behaviour into E13": the fleet's tests become the acceptance tests for TASK-84/85/86.

## 15. Phased build plan

Each phase is shippable and leaves a working fleet. v1 keeps running untouched until phase 3 replaces it.

**Phase 0: contracts (days, architect + 1 engineer).** `Provider` (a subset of `ProviderAdapterShape`, §14.1), event schema, projection schemas, `SessionSpec`,
Mailbox API as typed files and golden tests, named in IsnadiBot's vocabulary (§14.1). Merged first, small. Everything below builds on it (§12).

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

**Phase 4: port into IsnadiBot.** The proven behaviour moves into E13 (§14.1); the fleet's tests become its acceptance tests.

## 16. Risks

- **Agent SDK coverage.** If a provider cannot report usage or waiting-input, its purge and unblock quality degrade;
  `capabilities` makes that explicit and the fallback is turn count. Spike this first for `claude` and `deepinfra`.
- **Long-lived daemon.** A crashed `fleetd` must be resumable from the store; the supervisor starts idempotently and
  reconciles. The daemon is the new single point of failure and needs its own health check and log.
- **Judge on a cheap model** can be wrong; the closed question list and `escalate` bound the damage, and the log
  makes it reviewable.
- **Scope.** This is a rewrite. The mitigation is phase 1's single provider and its hard exit test.
