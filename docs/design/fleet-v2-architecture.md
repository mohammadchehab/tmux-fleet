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

## 1.1 Repository layout

One workspace of TypeScript packages in the existing tmux-fleet repo (`@fleet/<group>-<name>`; Node >=22.18 runs the
TypeScript directly, no build step; no runtime dependency outside `node:` builtins plus the SQLite driver and each
provider's own SDK inside its package). Section numbers are this document's.

**Rule: no folder is a flat bag of siblings.** Every level groups by domain; a folder holds either sub-groups or the
packages of one group, and a group with a single member is a leaf, not a folder of one.

```
tmux-fleet/
├─ packages/
│  ├─ foundation/                 # what everything may import; no domain logic that other groups own
│  │  ├─ core/                    # ids, event envelope, Result/Error, clock, pure helpers, the `exec` and `io` shapes (§3)
│  │  ├─ contracts/               # the schemas and ports every group shares: commands, events, API types, and the ports other groups need from each other, e.g. `PullRequests` (§3, §10)
│  │  └─ store/                   # append-only SQLite event store, projections, migrations, replay (§3, §5.4)
│  ├─ runtime/                    # running peers
│  │  ├─ providers/
│  │  │  ├─ sdk/                  # the Provider interface, SessionSpec, ProviderEvent, conformance helpers (§4)
│  │  │  ├─ claude/               # Claude Agent SDK (CLI fallback); base for deepinfra (§4)
│  │  │  ├─ deepinfra/            # claude with per-session DeepInfra env; model read from the process (§4)
│  │  │  └─ cursor/               # `cursor-agent`, one process per turn; read-only plan mode, usage as a proxy (§4)
│  │  ├─ supervisor/              # session lifecycle, restart, permission-mode check, self-purge wrapper (§2, §8)
│  │  └─ mailbox/                 # addressing by peerId, briefs, versions, acks, resume-then-deliver (§7)
│  ├─ orchestration/              # deciding and moving work
│  │  ├─ pm/                      # the work state machine, decide(), rules, Judge client, Decision log (§5)
│  │  ├─ routines/                # scheduler + routines: dispatch, keep-busy, pr-babysit, branch-cleanup, standup, reconcile (§6)
│  │  ├─ briefs/                  # Contract and Brief publishing, dependency gating, staleness (§12)
│  │  ├─ gate/                    # PR gate, stack retarget, merge-ownership policy (§10)
│  │  ├─ ledger/                  # Build ledger and the remote (hetzner) runner (§11)
│  │  └─ judge/                   # the Judge: five typed questions, logged and replayable; the daemon injects its model transport (§5.3)
│  ├─ workspace/                  # the code and the checkouts peers work in
│  │  ├─ worktree/                # create, classify, holders, GC, link check (§9)
│  │  └─ codegraph/               # ensure-index, MCP wiring, PreToolUse guard policy, token-report projection (§6.2)
│  ├─ security/
│  │  ├─ scanners/                # Scanner adapters: semgrep, gitleaks, osv-scanner, trivy, claude-security (§6.2)
│  │  └─ findings/                # typed finding events, fingerprint dedupe, verdicts, routing to work and decisions (§6.2)
│  ├─ notify/
│  │  ├─ core/                    # notification projection, dedupe/rate-limit rules, decision inbox, `Notifier` interface (§6.1)
│  │  └─ channels/
│  │     └─ macos/                # terminal-notifier / osascript notifier; phone and Slack are siblings later (§6.1)
│  ├─ evals/                      # dev tooling: evaluation of the non-deterministic parts (§17); never imported by runtime code
│  │  ├─ adapter/                 # turns promptfoo results into `eval.run_finished` / `eval.case_scored` events (§17)
│  │  └─ suites/
│  │     ├─ judge/                # custom promptfoo provider calling the real Judge path, scorers, case loader (§17)
│  │     ├─ briefs/               # roles and briefs: scripted scenario to typed artifacts (§17)
│  │     ├─ purge-resume/         # StateFile fidelity after a purge (§17)
│  │     ├─ security-triage/      # findings to verdicts (§17)
│  │     └─ model-choice/         # the same cases across providers/models, a comparison not a gate (§17)
│  └─ integrations/
│     ├─ github/                  # `gh`/git adapters behind the contracts' ports: PRs, checks, retarget (§10)
│     ├─ gitlab/                  # the same port over `glab`, for a self-hosted GitLab: MRs, pipelines, approvals (§10)
│     └─ trackers/
│        └─ backlog/              # the `Tracker` port over the `backlog` CLI; Jira is a sibling later (§3)
├─ apps/
│  ├─ daemon/                     # `fleetd`: the only place the groups are wired together; store owner; local API on a Unix socket (§2)
│  ├─ clients/
│  │  ├─ board/                   # `fleet-board`: a read-only web board of Work items, from `ls` and `work` (§2, §3)
│  │  ├─ cli/                     # `fleet`: thin API client: up, down, ls, send, peek, decide, replay (§2, §6.1)
│  │  └─ view/                    # `fleet-view`: a read-only pane per peer, from the daemon API (§2)
│  └─ hooks/
│     ├─ tool-guard/              # PreToolUse entry: redirects broad Grep/Glob/Read sweeps (§6.2)
│     └─ usage-report/            # Stop/usage entry: reports per-turn usage; tiny import graph (§6.2, §8)
├─ config/
│  ├─ definitions/
│  │  ├─ roles/                   # one file per role: brief, default provider/model/effort, permission mode, tools (replaces skills/fleet/roles + models)
│  │  └─ squads/                  # peer lists per squad (replaces skills/fleet/squads)
│  ├─ policies/
│  │  ├─ merge/                   # merge ownership, PR cap (§5, §10)
│  │  ├─ security/                # scanner set per repo, critical definition (§6.2)
│  │  ├─ codegraph/               # guard mode per role (§6.2)
│  │  ├─ notify/                  # classes, windows, reminder hours (§6.1)
│  │  └─ limits/                  # context limits per provider/model, wait times (§8)
│  └─ profiles/
│     └─ examples/                # `example.yaml`; real profiles live in the user's home, below
├─ tests/                         # cross-package tests only; unit tests sit beside their package as `*.test.ts`
│  ├─ architecture/               # the import-direction test over the workspace graph (below)
│  ├─ conformance/
│  │  └─ providers/               # one suite every provider package must pass (§4)
│  ├─ evals/
│  │  ├─ cases/                   # `<suite>/<id>.json`: input, expected or rubric, source (§17)
│  │  ├─ baselines/               # committed `<suite>.json`; improving one is a deliberate commit (§17)
│  │  └─ promptfoo/               # one promptfoo config per suite (§17)
│  ├─ integration/
│  │  ├─ lifecycle/               # fleetd + a fake provider: start, kill, resume, identity (§7)
│  │  ├─ self-purge/              # purge and resume at a limit (§8)
│  │  ├─ delivery/                # assign, PR gate, merge, notify: the phase 1 exit test (§5, §10)
│  │  └─ security/                # scanner fixtures to findings to decisions (§6.2)
│  └─ fixtures/
│     ├─ provider-streams/        # recorded provider event streams (§4)
│     ├─ repos/                   # git/gh sandboxes for worktree, gate and scanner tests (§9, §10)
│     └─ event-logs/              # golden event logs for replay (§5.4)
├─ docs/
│  ├─ design/                     # this document and later architecture specs
│  ├─ decisions/                  # ADRs
│  ├─ ideas/                      # the E13 idea map and lessons (§14.1)
│  └─ runbook/                    # operating the fleet
└─ package.json  tsconfig.json  Taskfile.yaml  AGENTS.md  README.md   # workspace root; `task test` is the gate
```

### Dependency direction, by group

```
foundation   <-   runtime, orchestration, workspace, security, notify, integrations     (every group depends on foundation)
apps/daemon  <-   all groups                                                            (the only wiring point)
apps/clients, apps/hooks  ->  the daemon API / foundation types only
```

- **Groups never import each other sideways.** If `orchestration` needs something `runtime` or `integrations` does, it
  declares a **port in `foundation/contracts`** (e.g. `PullRequests`, `ProviderRegistry`) and `apps/daemon` injects the
  implementation. Otherwise groups cooperate through **events in the store**. This is what keeps `pm` pure and
  `gate` testable without `gh`.
- **Inside a group**, packages import `foundation` and only the earlier-listed siblings they need: every
  `providers/<x>` imports `providers/sdk`; `scanners` imports `findings` types; `notify/channels/*` import
  `notify/core`; `supervisor` and `mailbox` import `providers/sdk`. `pm` imports `foundation/core` and
  `foundation/contracts` only (pure: state in, actions out, §5). A provider never imports `store`; `supervisor`
  adapts its events into the store.
- **`evals` is a leaf consumer, like an app:** it may import any group (its suites call the real Judge and Provider path), nothing imports `evals`, and `promptfoo`/`openevals` appear only in `packages/evals/*` dev dependencies; `tests/architecture` enforces both (§17).
- `apps/*` never import each other. `apps/clients/*` talk to the daemon over the socket, which keeps tmux and the CLI
  a view, not the control plane.
- `tests/architecture` fails the build if an import violates any rule above.

### On disk

Nothing the fleet writes at runtime lives in the repo or in a worktree.

**Decided (Mohammad, 2026-11-10):** profiles move from `.env` to YAML at `~/.config/fleet/profiles/<profile>.yaml`, and v2 runtime state lives in `~/.fleet/<profile>/`.

```
~/.config/fleet/profiles/<profile>.yaml       # the user's profile: target repos, policy overrides, notify, limits (was ~/.config/fleet/profiles/*.env)
~/.fleet/<profile>/
   store/        store.sqlite, store.sqlite-wal, backup/           # the event store and its nightly copy (§3)
   daemon/       fleetd.sock, fleetd.pid, fleetd.lock, fleetd.log  # API socket, pid, store lock, log (§2)
   peers/        <peerId>/state.md                                 # human copy of each peer's latest typed state file (§8)
   transcripts/  <peerId>/<sessionId>.jsonl                        # provider event streams, source for the optional view
   artifacts/    findings/, builds/<sha>-<task>.log                # scanner raw output, build logs (§6.2, §11)
   notify/       <key>.json                                        # delivered-notification receipts (§6.1)
```

Git worktrees are not here: they live under each repo's own `.claude/worktrees/<topic>`, and their state is events in
the store (§9). Role and peer *definitions* are config in the repo (`config/definitions`) with per-profile overrides in
the user's profile; the *live* peers (ids, sessions, briefs) exist only in the store. v1's `$FLEET_STATE`
(`~/.fleet-state/<profile>`) is left untouched; `fleet migrate` (phase 3) imports its roster and board once, read-only.

### What happens to the old bash

| v1 path | transition | removed |
| :- | :- | :- |
| `skills/`, `bin/`, `dev-tasks/`, `profiles/`, `hooks/` | moved under `legacy/v1/` in phase 0 by one mechanical commit, kept working, **deprecated** (fixes only); `task install` links from there; the live fleet keeps running on it | **phase 3**, after `fleet migrate` and a week of the v2 fleet running a real squad |
| `skills/fleet/roles/*.md`, `squads/*`, `models` | content copied into `config/definitions/{roles,squads}` in phase 1 (role text reused, the model/effort table becomes fields) | with the rest, phase 3 |
| PRs #12 (dispatch/judge) and #13 (context-guard) | stay as the interim fleet's stopgap until phase 1's exit test passes; not extended | phase 3 (their rules live in `orchestration/pm` and `runtime/supervisor`) |
| `skills/*/SKILL.md` for Claude Code skill loading | a thin v2 `fleet` skill stays (tells a peer how to talk to the daemon through the CLI) | kept |

### What each phase adds to the tree

| phase | adds |
| :- | :- |
| 0 contracts | `packages/foundation/{core,contracts,store}` (types and schemas only), `packages/runtime/providers/sdk`, `tests/{architecture,conformance}` skeleton, `docs/`, workspace root files; v1 moves to `legacy/v1/` |
| 1 vertical slice | `foundation/store` (working), `runtime/providers/{claude,deepinfra}`, `runtime/{supervisor,mailbox}`, `orchestration/{pm,routines,gate}`, `notify/{core,channels/macos}`, `integrations/github`, `apps/daemon`, `apps/clients/cli`, `apps/hooks/usage-report`, `config/{definitions,policies}`, `tests/{integration/{lifecycle,self-purge,delivery},fixtures}` |
| 2 hygiene | `workspace/{worktree,codegraph}`, `orchestration/{briefs,ledger}`, `security/{scanners,findings}`, `apps/hooks/tool-guard`, `tests/integration/security`, stack retarget in `gate`, `fleet replay` |
| 3 providers and sinks | `runtime/providers/cursor`, `integrations/trackers`, `apps/clients/{view,board}`, `fleet migrate`; `legacy/` deleted |
| 2 evals (with 2 hygiene) | `packages/evals/{adapter,suites/judge}`, `tests/evals/{cases/judge,baselines,promptfoo}`; the eval event contracts can land in phase 1 (§17) |
| 4 hand-off | docs only: `docs/ideas` with measured lessons |

The security routine can start earlier than phase 2 on the interim fleet; phase 1's exit test does not depend on it.

## 2. Components

```
                       ┌──────────────────────── fleetd (one process per fleet) ───────────────────────┐
 fleet CLI / board /   │  Supervisor ── PM state machine ── Scheduler (routines)                        │
 tmux view / web  ───► │      │             │                    │                                      │
   (thin clients,      │  Registry ── Mailbox ── Worktree manager ── PR gate ── Build ledger           │
    API only)          │      │             │                                                           │
                       │  ┌───┴──────── Provider interface ─────────┐        ┌── Judge (typed LLM call) ┐│
                       │  │ claude │ deepinfra │ cursor             │        └──────────────────────────┘│
                       │  └─────────────────────────────────────────┘                                    │
                       │  Event store (append-only SQLite) + projections                                 │
                       └─────────────────────────────────────────────────────────────────────────────────┘
```

- **fleetd**: a long-lived local daemon, one per fleet profile. Owns the store, runs every loop, exposes a local API
  (Unix socket, JSON). The CLI, the board, the tmux view and any web UI are clients of that API and hold no state.
  It is started by `fleet up`; `fleet up` after a reboot resumes from the store (§8). It holds a pid lock on its
  store, so a second fleetd on the same store is refused rather than started beside a live one; `fleet down` ends
  the process, and a lock whose pid is dead is taken over by the next `up`. The profile it reads is a file a person
  writes — `fleet init <profile>` writes a commented starter, once, and never over an existing one, so the first
  run starts from every valid spelling instead of from memory.
- **Event store**: append-only SQLite (WAL). Everything that happens is an event; every table the code reads is a
  projection rebuilt from events. Replay of a window of events reproduces every PM decision (§5.4).
- **Registry**: peers, roles, sessions, current brief version, capacity. Projection.
- **Mailbox**: the only way anything talks to a peer (§7).
- **Provider interface**: §4.
- **Supervisor**: restarts dead sessions, enforces the permission mode, maps provider events to peer state.
- **PM state machine, Scheduler, Judge**: §5 and §6.
- **Worktree manager, PR gate, Build ledger**: §9, §10, §11.
- **tmux view** (optional): `fleet-view` opens a session named after the profile with one read-only pane per peer,
  each redrawn from `ls` on an interval — the peer, its state, its role, provider, session and brief. It is a second
  client of the API, not a pane onto the provider: a transcript is the provider's business and the daemon already
  holds what the view shows. No key it receives does anything either: the panes have no shell behind them, and inside
  a pane the only byte read is ctrl-c. `--once` prints the same view without tmux, which is how it is tested and how
  it runs over ssh; a pane that loses the daemon draws why instead of exiting, so the view survives a restart of the
  thing it is watching. The command is `fleet-view` and not `fleet view` because §1.1 puts the view in its own app
  and apps never import each other — the CLI could not reach it to expose it as a subcommand, and moving the view
  into the CLI would make the CLI two things.
- **web board** (optional): `fleet-board` serves one page at `/` and is a read of two methods — `ls` for the header,
  `work` for the rows — re-asked on every request, with no cache, no script on the page and nothing written anywhere.
  Each row is the projection's own `Work`, in the projection's order; the page groups them by state to be readable and
  never filters them, because a board that decided which items exist would be a second opinion about the fleet (§2).
  It is a separate app from the tmux view for the reason the view is separate from the CLI (§1.1), and `--once` prints
  the same page without a socket listener, which is how it is tested.

## 3. Data model

Event envelope: `{seq, ts, type, subject, actor, causedBy, data}`. `actor` is `pm | scheduler | peer:<id> | user |
judge:<model>`. `causedBy` links a decision to the events it was made from.

Core entities (projections), all keyed by **stable ids**, never by tmux names or session refs:

| entity | key fields |
| :- | :- |
| `Peer` | `peerId` (stable, `engineer-1`), `role`, `providerId`, `model`, `permissionMode`, `worktreeId?`, `currentSessionId`, `briefVersion` |
| `Session` | `sessionId`, `peerId`, `providerSessionRef`, `startedAt`, `endedAt?`, `endReason`. A peer has many sessions over time; the peer never changes |
| `Work` | `workId`, `title`, `state` (§5.1), `assignee?`, `contractId?`, `dependsOn[]`, `prs[]`, `external` (tracker system, key and url, §3) |
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

The seam is one port in `foundation/contracts`, so a new tracker is an adapter and not a new routine:

```ts
interface Tracker {
  pull(query: string): Promise<readonly ExternalItem[]>          // {system, key, title, body?, status, url?, updatedAt?}
  get(key: string): Promise<ExternalItem | undefined>            // undefined = no such card; a broken read throws
  transition(key: string, to: WorkState): Promise<void>          // through the profile's WorkState → status map
  link(key: string, prUrl: string): Promise<void>                // append, never overwrite; idempotent per URL
}
```

`tracker-sync` (§6) is the only caller. A heartbeat pulls the profile's query and turns each key no `Work` names yet
into `work.proposed` with `external` set; a work event moves that one card, and `work.review_requested` also links the
PR. A state the profile does not map is **not** sent — a board is a peer, not a mirror, so the fleet never invents a
column. A pull that fails throws (`routine.failed`); a single card the board refuses is counted in `tracker.synced`
and in `actionsFailed`. The ticket is read with `get` at propose time, so the `Work` and its brief carry the ticket as
it was then; a card edited afterwards is not re-read, because no `work.*` event updates a title or a body.

## 4. Provider interface (the SDK)

Providers are the only code that knows a vendor. The interface is small and every method is typed; there is no
method that returns text meant to be parsed.

```ts
interface Provider {
  readonly id: string                                    // "claude", "deepinfra", "cursor"
  readonly capabilities: { resume: boolean; modelSwitch: boolean; usageTokens: boolean; usageCost: boolean;
                           structuredOutput: boolean; permissionModes: PermissionMode[] }
  start(spec: SessionSpec): Promise<SessionHandle>       // spec carries cwd, env, model, permissionMode, role brief, resume ref
  send(h: SessionHandle, msg: Turn): Promise<TurnId>     // a turn, never keystrokes
  interrupt(h: SessionHandle, turn?: TurnId): Promise<void>
  stop(h: SessionHandle): Promise<void>
  answer(h: SessionHandle, questionId: string, answer: Answer): Promise<void>        // resolves a pending question
  respond(h: SessionHandle, requestId: string, decision: "allow" | "deny"): Promise<void>  // resolves a pending approval
  status(h: SessionHandle): Promise<PeerState>           // last known, derived locally; "starting"|"working"|"waiting_input"|"idle"|"ended"|"failed"
  usage(h: SessionHandle): Promise<{ contextTokens: number; contextLimit: number; costUsd?: number }>
  model(h: SessionHandle): Promise<{ id: string; endpoint?: string }>   // the LATEST init's model, never a UI string
  events(h: SessionHandle): AsyncIterable<ProviderEvent> // plain data only: turn.started/ended{reason}, tool.use, question.asked, approval.requested, question.abandoned, approval.abandoned, session.ended, error, compaction
  setModel(h: SessionHandle, model: string): Promise<void>   // always present; rejects FleetError("unsupported") when capabilities.modelSwitch is false; confirmed one turn late (next init)
  resume(ref: ProviderSessionRef, spec: SessionSpec): Promise<SessionHandle>   // always present; rejects FleetError("unsupported") when capabilities.resume is false (untested: both live providers report true)
}
```

The shared types (`SessionSpec`, `Turn`, `ProviderEvent`, `PermissionMode`, `ProviderSessionRef`, `Usage`) live in
`foundation/contracts`; `runtime/providers/sdk` declares only `Provider` and the capabilities over them, so `pm`,
`notify` and the store never import a provider package.

- **`waiting_input` is a plain-data event**, not a regex on `?`: `question.asked {turnId, questionId, questions[]}`
  and `approval.requested {turnId, requestId, tool}`. The decision inbox answers through `answer()`/`respond()`, never
  by resolving something carried in an event (events are stored and replayed). The adapter keeps the pending
  promise keyed by an id it mints; `status()` is `waiting_input` while any is pending. A dead session leaves the
  promise unresolved with no SDK event, so the adapter emits `question.abandoned` and the supervisor re-delivers the
  stored answer on resume as a `nudge` turn (the promise is not durable).
  **A pending item belongs to the session that raised it, and a session that ends closes everything it owns**, with
  an explicit `question.abandoned` or `approval.abandoned` per item. A replacement re-asks from its state file; it
  never inherits. A pending question outliving its session is therefore a state the supervisor does not model: at
  each turn boundary every open turn and pending item must belong to the session the boundary is on, and a foreign
  one is recorded as `provider.errored {code: "invariant"}` — which the store raises a failure notification for — and
  stops that peer's pump rather than skipping the boundary. It used to skip it, which left the peer un-purgeable for
  the rest of its life with nothing written down.
- **`session.ended` is synthesised by the adapter**, not read from a stream frame: the Claude SDK never emits it. The
  adapter derives it from the event iterator finishing or throwing, or from the process exiting. The iterator does
  **not** finish on interrupt, only when the input stream closes or the process ends (spike §5), so an interrupt
  produces `turn.ended {reason: interrupted}` and no `session.ended`.
- **`turn.ended` carries `reason: completed | interrupted | failed`** (+ `error`). Only `failed` raises a
  `peer.failed` notification (§6.1); a deliberate interrupt notifies nobody. (Claude SDK: `is_error` with
  `terminal_reason: aborted_tools` is `interrupted`, other `is_error` is `failed`.)
- **`usage()` separates three things that fail independently.** `contextTokens` comes from the provider.
  `contextLimit` is **always from config** (`config/policies/limits`, per provider + model), never from the SDK: a
  DeepInfra session reports a 200,000 window for a 1,048,576 model, which would purge at 20%. `costUsd` is present
  only when `capabilities.usageCost` is true; DeepInfra's SDK cost is priced at Claude list rates and is not real, so
  the §11 ledger records it as null.
- **Permission mode and env are part of `SessionSpec`**, validated by the supervisor against the peer's declared
  mode before `start`. A session that comes up in another mode is stopped and restarted, not tolerated (§13). The
  launch-mode check reads the **first** init event (`model()` follows the **latest**, which is how a model switch
  shows); a capture variable that just keeps overwriting reports neither correctly. The conformance suite asserts the
  first init carries the requested mode and that a write in `default` reaches the approval path.
- **Peers run in `default` with a tool policy, never `bypassPermissions`** (decided 2026-11-10): bypass shadows the
  approval path (`canUseTool` is never called), so a question is auto-approved with no answer and the decision inbox is
  blind. `SessionSpec.toolPolicy` (`{defaultAction, rules: [{tool, pattern?, action}]}`, first match wins, default
  `ask`) stands in for it: `allow` runs silently, `deny` emits `tool.denied` and tells the model, only `ask` and
  `AskUserQuestion` reach `waiting_input`. A Bash `allow` rule never matches a command with a control construct
  (`;` `&` `|` backtick `$(` `<(` `<` `>` newline: that is `ask`); matching sees the whole string (over 64 KB is `ask`),
  file paths are resolved before matching, and `allow` patterns must be fully anchored. It is a guard rail, not a
  sandbox: "no production" is enforced by the peer's environment, never by a regex.
- **`SessionHandle.briefTurnId`** is the turn the brief was sent as (some SDKs say nothing until a first user message);
  the first `turn.started` refers to it. The stored `session.started` event records the *effective* model, permission
  mode and (when the adapter recorded it) endpoint.
- **Env is built, never inherited.** The adapter never spreads `process.env`; it builds the child environment from an
  explicit allowlist (PATH, HOME, TERM, LANG, TMPDIR, …) plus `SessionSpec.env`, and starts with
  `settingSources: []` so the developer's own settings, hooks and env do not leak in (a bare run fired 13 hook frames
  from a dev's settings; a leaked `ANTHROPIC_BASE_URL` made a session asked for `claude` silently run DeepSeek).
  After start the supervisor compares what it observes with the spec: **observed = model id (always) + base URL
  (when the adapter recorded what it set; the SDK does not expose it)**. A mismatch stops the session and emits
  `peer.failed {reason: "config_mismatch", expected, observed}`.
- **Implementations:**
  - `claude`: the Claude Agent SDK (preferred; gives events, usage, resume and structured output), falling back to
    spawning the CLI with `--output-format stream-json`. Spike (`docs/design/spikes/agent-sdk.md`): SDK 0.3.322
    carries this interface for both claude and deepinfra.
  - `deepinfra`: the same Claude implementation with `ANTHROPIC_BASE_URL`/key/model set in `SessionSpec.env` of
    *that one process*. No shared tmux server seeds env, so there is no drift.
  - `cursor`: the `cursor-agent` CLI, one process per turn, resumed by chat id — **read-only, plan mode only**, and
    the exception to the paragraph above about peers running in `default` with a tool policy. This CLI has no
    per-call hook for a policy to ride on, so the guarantee is the mode itself: `capabilities.permissionModes` is
    `['plan']`, and a `start` in any other mode is refused `unsupported` before a process spawns. A `toolPolicy` is
    accepted and ignored; `answer()`/`respond()` reject `unsupported`, because a mode that asks nobody cannot raise
    a question. Four things it does not do as well as the SDK providers, each deliberate:
    `model()` reports the id the session was started with (*requested, not confirmed* — the CLI's `init` names a
    display name, so nothing here can raise `config_mismatch`); `usageTokens` is a turn-measured proxy (the prompt
    side of the last turn — input + cache read + cache write — because a turn is a process and no call reports the
    conversation's own size); `usageCost` and `structuredOutput` are false (Cursor bills by subscription, and the
    CLI takes no schema); and a session with MCP servers is refused rather than wired. The window still comes from
    config (`providers.cursor.contextLimits`), and a model without one is refused at `start`. A turn's process
    exiting is *not* `session.ended`: only `stop()`, or an executable that could not run at all, ends the session,
    or the supervisor would restart a healthy session after every message.
- A provider that cannot do something says so in `capabilities`; the supervisor adapts, it does not guess.
- **Untested path:** the `resume()` `unsupported` branch has no evidence behind it, since claude, deepinfra and
  cursor all report `resume: true`. It is written when a provider that cannot resume exists, not assumed.

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
| unblock | peer `waiting_input` ∧ its own `Work` is `blocked` | route by `Work.blockedOn`: an answered `Decision` from the log if there is one, else the reviewer role for `peer`/`contract`, else a `Decision` row for the user — one per `Work`, never a Judge call |
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

Every Judge call and every rule firing writes a `Decision` with `inputsHash`. `fleet replay` drops every projection and
derives it again from `events`, which is what makes a projection a cache and not a second source of truth; the store
asserts the result agrees with the log, so a projection that cannot be rebuilt from events fails rather than being
quietly rewritten. `fleet replay --from <seq> [--to <seq>]` reads that window of the log instead of writing anything —
the debugging half, and a read, so it works against a running fleet.

Re-running `decide` over a window and diffing its actions against the logged ones is the other half of the audit and is
**not built yet**; rules are deterministic, so that diff is how a change in the code shows up as a change in behaviour.
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
| `worktree-gc` | daily | §9: orphaned checkouts and stray holders; the merge half is `branch-cleanup`'s |
| `branch-cleanup` | `work.merged`/`pr.merged` + daily 04:00 | §10: deletes a merged branch pinned to the merged head, after retargeting any dependent; removes that Work's worktree; sweeps the rest and tells owners instead of deleting |
| `reconcile` | startup + 10 min | provider `status` vs registry; restart dead sessions, fix drift |
| `security-scan` | PR assigned to security-architect, nightly | §6.2: runs scanners, raises typed findings |
| `notify` | events + 5 min | §6.1: the notification projection, delivered through `Notifier` |
| `tracker-sync` | 5 min heartbeat + `work.started`/`review_requested`/`merged` | §3: a heartbeat pulls the profile's query and proposes a Work per unseen card; a work event moves that card and links the PR |

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
   For a peer whose CLI has hooks, `apps/hooks/usage-report` is the Stop hook that does this: it measures the turn
   from the transcript (tokens, and Grep/Glob/Read/codegraph calls by tool name) and sends the daemon's `usage` call
   (`FLEET_PEER`, `FLEET_SOCKET`, `FLEET_CONTEXT_LIMIT` from the profile, optional `FLEET_WORK_ID`); it never fails the
   peer, and it skips, with the reason, rather than guess a missing context limit.

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
  parent's base.
- **Merging never deletes.** The gate no longer passes `--delete-branch` at all (#102): a merge that deletes cannot be
  retried without it, and a dependent that appears mid-merge is a branch someone still sits on. Deletion is its own act,
  `branch-cleanup` (§6), with its own pin: the delete names the sha it expects and refuses a branch that moved
  (`head_moved`). The rule is **no deletion while a dependent exists**, not "never delete": a dependent is retargeted
  onto the base the merge went into first, and a dependent that cannot move keeps the branch alive.
- **Two triggers, one rule.** A `work.merged` event deletes that branch with the merged head sha and removes the merged
  Work's worktree (§9), recording `branch.deleted {repo, branch, sha, by}` — the sha is the commit to restore the branch
  from. A nightly sweep deletes only branches whose head equals a merged PR's head; anything else (closed without merge,
  no PR, commits after the merge) is left alone and the owner is told.
- **Trunk is whatever the forge says it is.** Both triggers refuse to delete the repository's default branch, asked of
  the forge (`defaultBranch`) rather than assumed: `main` and `master` are conventions, and a repo on `develop` or
  `release/2.x` is the same fact under another name. A forge that will not name its trunk is a refusal, not a guess —
  the one branch a bad rule must never take is the one everything else is based on.
- Merge ownership is a profile policy the gate enforces; with no reviewer role running the gate asks the user, it does
  not stall silently.

## 11. Build ledger and remote runs

`Build(repo, sha, task)` is unique. A peer requests a build through the API; the ledger returns the existing result
or runs it once. Heavy tasks route to the remote host (hetzner) by task class in the profile; light ones run locally.
The same SHA+task never runs twice and results are shared by all peers.

A build keeps two files under `artifacts/builds/`. `<sha>-<task>.log` is everything the build said — both streams, in
order — which is the only account of a build that ran on another host. `<sha>-<task>.out` is stdout alone, for a caller
that asked for an answer and not for narration; `fleet evals run` is the first such caller, and the path is derived from
`logPath` so a reader needs the one path the ledger already sends (`buildStdoutPath`, in `foundation` beside `buildKey`
— a client may import foundation and nothing else, §1.1). A remote build checks the sha out and then puts that
checkout's `node_modules/.bin` ahead of the host's PATH: a workspace bin is on no PATH but its own tree's, and a build
should run the tools its lockfile pins rather than whatever the box happens to have.

## 12. Contracts before work

A `Work` that depends on shared structure declares `contractId`. The PM does not assign it until that `Contract`
(a spec file merged in the repo, hashed) is `published`. Contract work is itself a `Work` assigned first, small and
fast-merged (the §2.1-style rules of the port plan become a contract). A new contract version supersedes dependent
briefs (§5.2 `stale`), so two peers cannot build on different layouts, and the foundation stops being a surprise
serial blocker because the PM sees it as a dependency edge and parallelises everything behind the contract.

### 12.1 Briefs

A **Brief** is the text a peer is judged against: immutable, versioned **per peer** (the version only goes up, and the
peer's `briefVersion` is the one its context carries), and tied to the contract versions it was written against.
It is never edited; a change is a new Brief and `brief.superseded` on the old one, which stays readable.

- **Decide, then execute.** The PM's `assign` and `supersede_brief` actions carry the complete `BriefHandoff` (§5.2),
  because `decide` is pure and cannot publish. `orchestration/briefs` is their executor: it checks the Work (`ready`,
  or for a supersede, still on the brief the decision was made against) and that the version goes up, appends
  `brief.published` + `work.assigned` (or `brief.superseded`) in one atomic batch, then sends the brief through the
  Mailbox as a `brief` message citing that version. Delivery and wake are the Mailbox's and the daemon's.
- **Events first, then the send.** A failed send leaves a published brief and an assigned Work, which is true; the
  retry is safe because a brief that is already the Work's current one is treated as done and the send is skipped when
  the same brief is already in the peer's mailbox.
- **The store follows `brief.published`:** the peer's `briefVersion` (for the Mailbox's stale check, §7) and the
  Work's current `briefId`/`briefVersion` (for the `stale` rule), without moving the Work's state.
- Contract gating stays the PM's (`needs_contract`): the executor does not re-derive it; a `ContractReader` port is
  the follow-up if the PM and the executor ever need to disagree-check.

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
| stacked-merge branch loss | §10: retarget before merge; merging never deletes, `branch-cleanup` deletes pinned and only with no dependent |
| 76 branches left behind (nothing ever deleted after #102) | §6/§10: `branch.deleted` on the merge event, plus a nightly sweep that deletes only a branch whose head a merge recorded |
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
| PR gate: green on current head SHA, retarget stacks first, deletion as a separate pinned act | PR queue is read-only | the gate rules (§10) and `branch-cleanup` (§6) | no merge, stack or cleanup handling |
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

**Phase 3: providers and sinks.** The `cursor` provider (read-only, plan mode only — see §4); the Backlog/Jira
adapters; tmux view; a web board on the daemon API; cut over from v1, delete the bash.

What phase 3 does **not** deliver for cursor, so nobody plans around it: a writing peer (refused by design), a
confirmed model (the CLI names a display name, so `model()` reports what was requested), a measured context (§8's
trigger runs on a per-turn proxy), a priced turn (`usageCost` is false, so the ledger records null), structured output,
MCP, questions or approvals. `opencode` is dropped from this plan: it was the second non-SDK provider to prove the
provider shape against, and `cursor` is now that provider.

**Phase 4: hand the ideas to IsnadiBot.** The lessons and measured results go into the E13 idea map (§14.1). No code is ported.

## 16. Risks

- **Agent SDK coverage.** If a provider cannot report usage or waiting-input, its purge and unblock quality degrade;
  `capabilities` makes that explicit and the fallback is turn count. Spike this first for `claude` and `deepinfra`.
- **Long-lived daemon.** A crashed `fleetd` must be resumable from the store; the supervisor starts idempotently and
  reconciles. The daemon is the new single point of failure and needs its own health check and log.
- **Judge on a cheap model** can be wrong; the closed question list and `escalate` bound the damage, and the log
  makes it reviewable.
- **Scope.** This is a rewrite. The mitigation is phase 1's single provider and its hard exit test.

## 17. Evals

Deterministic parts (`decide()`, routines, the gate) are covered by replay and integration tests. Evals cover what is
not deterministic. **Decided (Mohammad, 2026-11-10):** use existing tooling, not a hand-rolled harness. The
no-runtime-dependency rule (§1.1) applies to runtime code only; evals are dev tooling. Eval data stays local; no
hosted platform (no LangSmith, no Braintrust).

**Tools.** `promptfoo`, run locally, as a dev dependency of `packages/evals` only. Each suite has a custom JS provider
that calls the **real** Judge and Provider path, so an eval measures what production runs. Typed answers use
promptfoo's exact-match and JS assertions; free-text outputs use its `llm-rubric` with a **pinned grader model that is
never the model under test**. `openevals` / `agentevals` (MIT TS libraries, used locally with no hosted service) may
score purge-resume and the role suites where a trajectory or a structured comparison fits better. Nothing in `runtime`,
`orchestration`, or any other group imports these.

**Suites.**

| suite | input to the real path | scored by |
| :- | :- | :- |
| `judge` | the five `QuestionKind` inputs (§5.3) | exact match on typed fields (verdict, route target, kind) and a schema-validity rate: a malformed answer is a failure |
| `briefs` | role file + brief + a scripted scenario | JS assertions on the typed artifacts a peer must produce (a `StateFile`, a question, a PR plan), then `llm-rubric` for text quality |
| `purge-resume` | role + brief + `StateFile` only | five fixed questions (goal, done, next, open questions, constraints) answered by a fresh session, scored by rubric |
| `security-triage` | labelled findings (known-true, known-false) | exact match on `confirmed|dismissed`, plus rubric on the stated reason |
| `model-choice` | the same cases of the other suites | a comparison across providers/models (pass rate, tokens, cost, latency); never a gate |

**Cases** are data: `tests/evals/cases/<suite>/<id>.json` = `{id, suite, input, expected | rubric, source}`. Sources, by
value: (1) **real v1 incidents** rewritten as cases, which are the first regression set: the stacked-merge branch loss
(#102), a peer acting on a stale brief, a duplicate feature, a message to a dead session, a wrong-model env leak;
(2) recorded event logs and provider streams (`tests/fixtures/event-logs`, `provider-streams`) cut at the decision
point; (3) labelled scanner output; (4) **override capture**: `fleet evals capture <decisionId>` turns any production
`Decision` a human overrode into a candidate case.

**Scoring rules.** Each case runs N=3 times (the model is not deterministic) and the report shows pass rate with the
case count, never a percentage on fewer than 20 cases. Grader: temperature 0, pinned, sees only `{rubric, output}`; every
rubric item is yes/no so scores are countable; 10% of graded cases are spot-checked by a human whenever a baseline
changes. Always recorded: tokens in/out, cost (only when `capabilities.usageCost`, else n/a), latency, retries.

**How it runs.** `fleet evals run <suite> --provider X --model Y --repo <owner/name> --sha <sha>`. The run *is* a build
(§11): the CLI forms the task `evals:<suite>:<provider>:<model>` and asks the ledger for it, so a heavy run goes to
hetzner by task class and an identical one never repeats — unique on `(repo, sha, suite, provider, model)`, which is
§11's three-tuple key with §17's five-tuple identity written inside it. The caller names all five parts because a
default for any of them is a *different* key: a run would either open a second row for the same work or reuse an older
row's answer for something it never measured. What crosses the socket is only the run's command and the two variables
its provider reads — never the calling shell's environment, which would be exported on the remote host.
Triggers: on demand; nightly on `main`; and **required on any PR that touches** `config/definitions/roles`, the Judge prompts or question schemas,
model or limits config, or the `StateFile` schema (path-based, the same mechanism as the security-scan routine, §6.2).
**Gate:** no suite regresses beyond its tolerance against its committed baseline in `tests/evals/baselines/<suite>.json`;
raising a baseline is a deliberate commit with the run attached.

**Results are events.** A thin adapter in `packages/evals/adapter` reads promptfoo's JSON output and appends
`eval.run_started`/`eval.run_finished {suite, sha, provider, model, cases, passed, tokens, costUsd?}` and
`eval.case_scored {caseId, runId, pass, score, detail}`. Projections `eval_runs` and `eval_cases` serve the standup and
`fleet evals compare <runA> <runB>`; a nightly drop below tolerance raises a failure notification (§6.1).

**Phase and first slice.** Phase 2 (after the supervisor and Judge are real); the eval event contracts can land in
phase 1. Smallest first slice: the `judge` suite only: the promptfoo config, the custom provider, the adapter, about ten
v1-incident cases mapped to `same_feature`, `route_question` and `escalate`, run against claude and deepinfra, one
committed baseline, one `eval.run_finished` event, no LLM grader yet. It proves the loop (case, real path, score, event,
compare) before graders and the other suites are added.

**Open point to settle in the first slice:** promptfoo loads custom providers as JS; whether it loads our `.ts`
providers directly under Node's type stripping, or needs a plain `.js`/`.mjs` shim, is verified first. If a shim is
needed it is one file per suite and the logic stays in TypeScript.
