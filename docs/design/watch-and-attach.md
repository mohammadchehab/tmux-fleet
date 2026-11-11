# Watch and attach: see the fleet live, take any peer over

**Status**: design, spiked (§10).
**Builds on**: [`fleet-v2-architecture.md`](fleet-v2-architecture.md) — headless typed providers (§4), the Mailbox (§7),
the event store (§3), the tmux view (§2).

## 1. Intent

A person running a fleet must feel in control of it: they can see every peer working in real time, and they can take any
peer over in the provider's own CLI when something goes wrong. A fleet that runs in the background where it cannot be
seen or touched is a failed design, however well it works.

Success looks like this:

- One command shows every peer live: what it is saying, which tool it is running, the mail going in and out.
- From that view, arrow keys and Enter take a peer over. The real `claude` or `cursor-agent` opens on the peer's own
  session with its full history.
- When the person exits, fleetd carries on from the same session, including everything the person did.
- The view says what is waiting on the person, and they answer it there. An answer reaches the PM program as an event.
- Any one peer can be stopped and started without touching the others.
- No message is ever typed into a terminal by a program.

### Constraints

- **No PTY hosting and no keystroke delivery.** fleetd keeps driving peers headless through typed providers (§4 of the
  architecture). v1 delivered by typing into panes and a message could sit unsent in an input box; that mechanism does
  not come back.
- **The view is read-only towards a peer's session.** It never sends a peer input. Its keys select a peer and choose an
  action.
- **The view is not an imitation of a provider's UI.** It is a monitor. The native experience is the takeover.
- **Both providers, one design.** Claude (Agent SDK) and Cursor (`cursor-agent`, one process per turn) behave the same
  from the person's side.

### Non-goals

- Typing into a turn while fleetd is running it.
- Delivering inbound mail into a session while a person holds it (§9).
- Replaying a peer's text after a daemon restart.

## 2. What exists today

- `fleet-view` opens one tmux pane per peer. Each pane polls the daemon every 2 seconds and redraws a status card: state,
  role, provider and model, session, work, last tool, edit count, last turn time.
- `ProviderEvent` has no event for what a peer says. `tool.use` carries a short redacted summary.
- The daemon socket is request and reply. It has no streaming method.
- The `Supervisor` starts and stops all peers together. Nothing in the daemon calls `provider.resume`; recovery and
  `startPeer` always start a fresh session.
- There is no held state. Peer states are `starting | working | waiting_input | idle | ended | failed`.

- Decisions are events with states `open` and `answered`. `decide` is the only way to answer one, and only the `fleet`
  CLI calls it. `ls` returns the decisions.
- `turn.usage_recorded` carries context tokens and the limit, but no projection keeps the latest value per peer.

A team workshop on v1 (2026-11-11) showed what people need from this: messages sat unsent in a Cursor input three times
in forty minutes; seeing the peers work was what made the fleet make sense to them; they could not find what was waiting
on them without asking the PM agent; an approval made on the board went unnoticed by the PM; and the context percentage
per peer was the number they were told to watch.

A spike in `~/dev/fleet-sandbox` (2026-11-11) established:

- Claude: interactive `claude --resume <sessionId>` on an SDK-started session shows the full history, keeps the same
  session id on exit, and a later SDK resume sees the turns typed by hand.
- Cursor: interactive `cursor-agent --resume <chatId>` on a headless-created chat shows the history, and the next
  headless turn sees the turns typed by hand.
- A native CLI that inherits the caller's environment picks up stray variables (a stale `ANTHROPIC_BASE_URL` caused a
  402). The takeover must build the environment from nothing.
- Interactive `cursor-agent` leaves plan mode with one shift+tab and defaults to its own model, not the peer's.
- A session fleetd did not spawn can use the daemon over `FLEET_SOCKET` with `FLEET_PEER` set.

## 3. Design overview

```
                       fleetd
 ┌──────────────────────────────────────────────────────────────┐
 │  event store        mailbox        routines / judge          │
 │                                                              │
 │  supervisor ── one headless session per peer                 │
 │     ├─ engineer-1  claude (Agent SDK)        ─┐              │
 │     └─ architect   cursor-agent (per turn)   ─┴─ display     │
 │                                                  lines       │
 │  display feed: last N lines per peer, memory only            │
 └───────────────┬──────────────────────────┬───────────────────┘
                 │ socket: stream           │ socket: hold / release
                 ▼                          ▼
           fleet watch                fleet attach <peer>
           (read-only, live)          (native CLI, the person drives)
```

Three parts, each usable on its own:

1. **Hold and release** (§4): the daemon can stop one peer, mark it held, and later resume the same session.
2. **Attach** (§5): a client that holds a peer, runs the native CLI, and releases on exit.
3. **Watch** (§6, §7): a display feed from the adapters and one terminal program that shows it and starts a takeover.

## 4. Hold and release

A held peer is one a person owns for now. fleetd does not run it, deliver to it, recover it or assign it work.

**State and events.** Add peer state `held`. Add events `peer.held { peerId, sessionRef, at, by }` and
`peer.released { peerId, sessionRef, at }`. The hold lives in the store, so a daemon that restarts reads it and does not
start a fresh session over the person.

**Supervisor.**

- `hold(peerId, { now })`: wait for the turn boundary, or call `provider.interrupt` first when `now` is true. Then
  `PeerSession.stop()`, remove the entry from the running map, append `peer.held` with the session ref.
- The boundary is read from the turn events (`PeerSession`'s open turns), never from `provider.status()`: the Claude
  session reports `idle` while its opening turn is still in flight, so a hold that polls status would stop a peer
  mid-brief.
- A held peer keeps its workdir claim. The shared-checkout guard must still count a checkout a person is writing in.
- `release(peerId)`: build the peer's `SessionSpec` as `startPeer` does, call `provider.resume(ref, spec)`, construct a
  new `PeerSession` around the handle as `startPeer` does, append `peer.released`. The session start is recorded with
  `resumed: true`; today `#recordStart` hardcodes `false`. The Mailbox then delivers what queued.
- `start()` and recovery skip a held peer.

**What a resume sends.** Today both adapters' `resume()` send the full brief again as a model turn. On release that
costs a turn and re-briefs over what the person just told the peer. `SessionSpec` gains an optional `opening` that
replaces the brief for a resume. Release passes a short handback note: a person held this session from when to when,
carry on from the conversation, and how many messages follow. A first message cannot be dropped entirely, because the
Claude SDK's streaming input needs one.

**Mailbox.** Mail to a held peer stays pending. Today a stopped session leaves a dead entry in the running map and
`acquire()` leases it, so delivery fails; removing the entry on hold is what makes the mail queue.

**Routines.** Assignment and keep-busy rules key on `idle`, so a `held` peer already receives no new Work. Self-purge
skips a held peer.

**RPC.** `peer.hold { peerId, now? } -> { sessionRef, providerId, cwd, model, env, command }`, `peer.release { peerId }`.
`env` is the exact map `envFor` built for the headless session, run through the provider's allowlist; `command` is the
executable and arguments from a new optional `Provider.attachCommand(ref, spec)`, so what each CLI needs stays in its
provider package. Only the daemon can build the env (provider endpoints and keys come from the profile through
`compose.ts`), and a client may not import the daemon, so the daemon hands it over. When the profile sets a key, that
key crosses the socket to the attach client. The socket is the user's own and the client runs as the same user who owns
the key; the daemon must create the socket readable by its owner only. `peer.hold`
on a held peer returns the same answer, so reopening a session whose terminal died is the same call.

A hold waits for the turn boundary, which can be never (a turn parked on an approval nobody answers). It is therefore
tied to its connection: the socket's close aborts a pending `peer.hold` or `peer.stop`, and the session goes back to the
running map untouched, so a client that died cannot leave a peer half-taken — found live, where `fleet attach` and
`fleet release` both answered "already being held" for good. `fleet down` ends a pending wait the same way. The attach
client forwards SIGHUP and SIGTERM to the CLI and waits it out (escalating a CLI that ignores them), so a closed terminal
still ends in the release.

**Resume failing.** If `provider.resume` rejects on release, the supervisor falls back to a fresh start with the state
file, as recovery does today, and records the reason on `peer.released`. The peer is never left held with nobody
holding it.

## 5. Attach

`fleet attach <peer> [--now]` is a client of §4.

1. Call `peer.hold`. Print what it is waiting for when the peer is mid-turn.
2. Run the provider's CLI in the foreground, in the peer's `cwd`:
   - Claude: `claude --resume <sessionRef> --model <model>`.
   - Cursor: `cursor-agent --resume <chatId> --mode plan --model <model>`.
3. The environment is built from nothing: the `env` that `peer.hold` returned, plus `TERM`, `HOME`, `PATH` and locale.
   Nothing else is inherited. The command is the `command` it returned.
4. When the CLI exits, for any reason, call `peer.release`.

`fleet release <peer>` releases a peer whose attach client died without releasing.

What the person gets is the provider's CLI with its own settings, hooks and MCP servers. The peer's appended system
prompt and tool policy apply to fleetd's headless turns, not to the person's. That is accepted: a person driving is not
a peer.

**Cursor and writing.** Cursor peers are read-only and share the main checkout. The takeover starts in plan mode, and a
person who switches mode writes into that checkout. The spec accepts this for now and says so in the attach banner; a
worktree per Cursor peer is a separate decision.

## 6. Display feed

What a peer says is display data, not a fact the fleet decides on. It stays out of the event store, so the log does not
grow with prose and replay is unaffected.

**Adapter.** Add an optional `display(handle): AsyncIterable<DisplayLine>` to `Provider`. A `DisplayLine` is one of:

- `text`: a chunk of what the peer said.
- `tool`: tool name and the existing redacted summary.
- `turn`: started or ended, with the reason.

A provider without `display` shows status only.

- Claude: the query runs with `includePartialMessages: true`. That adds `stream_event` messages carrying text deltas and
  changes nothing else: `assistant`, `result` and `init` arrive as before, so the contract events do not move.
- Cursor: turns run with `--stream-partial-output`. Deltas are `assistant` lines that carry `timestamp_ms`; the final
  `assistant` line has none and repeats the whole text. The display takes the delta lines only, or the text shows twice.
- Thinking deltas are dropped. The view shows what a peer said and did.

**Daemon.** A ring buffer of the last N lines per peer (default 500), in memory. Lines are cut at a fixed width budget
before buffering, so a peer printing a large file cannot grow the buffer or the socket payload.

**RPC.** `peer.watch { peerId?, since? }` is the daemon's first streaming method: it answers with the buffered lines,
then pushes new ones until the client disconnects. The stream also carries the rows the view needs from the store —
peer state changes, mail sent and delivered, decisions requested and answered — so the view does not poll.

The shapes are `packages/foundation/contracts/src/watch.ts`, which both `fleet watch` and the editor extension read.
The framing stays newline-delimited JSON on the same socket. What changes:

- A second message kind beside the one response: stream frames `{ id, stream, ... }`, with `stream` one of `line`
  (a `DisplayLine` for a peer), `row` (a store fact), `ready` (the buffered history is sent; `seq` is the newest the
  daemon has, `from` the oldest it still holds) and `end` (the reason, then the daemon closes the connection).
  Every `line` and `row` carries `seq`, one counter for the daemon run, so a reconnect sends `since` and gets only
  what it missed.
- A request that cannot start (bad params) is answered as any request is, with one `{ id, ok: false, error }` line.
- One connection per watch. A stream on a shared connection would block every request queued behind it, and today's
  clients close the socket on the first line; a second request on a watch connection is refused.
- `DaemonStatus.protocolVersion` (an integer, 1 at first) is bumped whenever a stream frame or an RPC changes shape,
  so a client reads it on connect and knows whether it can speak to the daemon.

A slow or stalled client is dropped, never waited for. Today's server ignores what `write()` returns, and a stalled
client then buffers without bound (9 MB in 2 seconds in the spike). So the daemon destroys a watch socket whose unsent
output passes a cap (4 MiB), and ends a watcher that falls 2 000 frames behind with `end: dropped`; on `close` it ends
the iterator. The cap is not `write()`'s own `false`, which fires at 16 KiB — less than the replay a healthy client is
sent in one burst. The feed must not be able to slow a peer or grow the daemon.

A watcher is also not a way to hurt the daemon with what a peer prints: lines are cut before they are buffered, text
deltas are gathered into lines, and one push makes at most 50 lines — the rest of a flood is counted, not shown.

**Context used.** The peer's activity row carries `contextTokens` and `contextLimit` from the last
`turn.usage_recorded` (schema 10, not backfilled): a peer with no recorded turn has neither, and shows no number.

## 7. The watch program

`fleet watch` is one terminal program. It replaces the tmux grid, because a shared selection cannot span separate panes.
`fleet watch --once` prints the table and exits, as `fleet-view --once` does today.

```
 fleet watch ── profile ── 4 peers                              ↑↓ select  ⏎ actions  q quit
┌─ NEEDS YOU (2) ────────────────────────────────────────────────────────────────────────┐
│ ? decision  Approve the login plan for SMB-113?            3 options     asked 10:41   │
│ ? architect is waiting for input                                         since 10:44   │
├─ PEERS ──────────────────────────────┬─────────────────────────────────────────────────┤
│ ▶ engineer-1 ● 17%  Edit mailbox.ts  │ engineer-1 ── working ── claude/opus ── TASK-142│
│   engineer-2 ○ 11%  idle since 10:41 │─────────────────────────────────────────────────│
│   architect  ? 64%  waiting for you  │ ✉ in  pm: "refactor Mailbox.acquire"            │
│   reviewer   ■  —   stopped          │ Reading the lease code first.                   │
│   pm         ◆  —   assigned TASK-142│ ● Read  src/mailbox.ts                          │
│                                      │ ● Edit  src/mailbox.ts                          │
└──────────────────────────────────────┴─────────────────────────────────────────────────┘
```

The whole fleet stays visible while one peer is in detail. Each row in the peer list carries:

- the state mark (working, idle, waiting for a person, held, stopped, program);
- **context used**, as a percentage of the model's window, from the last `turn.usage_recorded`. It is the number a
  person watches because it is money; a row at or past the self-purge threshold is marked;
- **what the peer is doing now**, in one line: the tool and its target while working, otherwise the state and since
  when.

Keys: up and down move the selection through the needs-you rows and the peers, Enter opens the actions for the selected
row, `q` quits. No key reaches a peer.

Actions for a running peer:

- **Take over when this turn ends** — `peer.hold`.
- **Take over now** — `peer.hold { now: true }`.
- **Interrupt the turn, stay headless** — the existing interrupt.
- **Send a message** — an ordinary Mailbox message from the person.
- **Stop this peer** — §7.2.

Actions for a held peer: **Reopen the native session**, **Release back to fleetd**.

Actions for a stopped peer: **Start this peer**.

### 7.1 Needs you

In v1 a person asked the project-manager agent "what is waiting on me?". In v2 the PM is a program with no session to
ask, so the watch answers that question itself, at the top, always.

The strip lists, oldest first:

- every `open` decision (§6.1 of the architecture), with its question and how many options it has;
- every peer in `waiting_input`.

Enter on a decision opens its options; choosing one calls the existing `decide` method. `decide` appends the answer as
an event and the append wakes the routines, so the PM program acts on it in the same tick. Nobody has to tell the PM
that something was approved.

Enter on a waiting peer opens the peer's actions, with take over first.

`fleet watch --once` prints the same strip above the table, so "what is waiting on me" is also one command in a script
or over ssh.

### 7.2 Stop and start one peer

A person must be able to drop a peer that is costing more than it is worth, and bring it back, without touching the
others.

- Add peer state `stopped` and events `peer.stopped { peerId, sessionRef, at, by }` and `peer.started`.
- `Supervisor.stopPeer(peerId)`: as `hold`, but nobody owns the session afterwards. `Supervisor.startPeer(peerId)`
  resumes from the recorded ref with the handback note of §4, and starts fresh when there is no ref or resume rejects.
- A stopped peer is skipped by `start()`, recovery, assignment and self-purge, and survives a daemon restart, exactly as
  a held peer does. Its mail stays pending. Work it holds stays assigned to it; the watch shows that on its row so the
  person can see what stopping it has parked.
- RPC: `peer.stop { peerId, now? }`, `peer.start { peerId }`. CLI: `fleet stop <peer>`, `fleet start <peer>`.

Held and stopped share one mechanism in the supervisor: a peer that is deliberately not running, with a recorded ref and
a reason. They differ in who ends it: a held peer is released by the attach client exiting, a stopped peer by a person
asking.

### 7.3 Answering from the board

The web board (`fleet-board`) reads only. A person who sees a decision there has to leave it for a terminal to answer.
The board gains an answer control on each open decision: a POST that calls `decide`, under the same host rule that
already limits who the board answers to. It writes nothing else. With §7.1 this makes every place a decision is shown a
place it can be answered, and every answer the same event.

Taking over from the menu suspends the watch program, runs the same attach flow as §5 in the same terminal, and
returns to the watch when the CLI exits. Two rules make that handover safe, both proven in tmux, iTerm2 and macOS
Terminal:

- The watch ignores SIGINT while the child owns the terminal. Otherwise ctrl-c in a child that is not in raw mode kills
  the watch with it.
- After the child exits, however it exits, the watch resets the terminal modes a CLI can leave on (mouse reporting,
  bracketed paste, focus events, keyboard protocol, cursor shape) before it redraws.

The watch is plain ANSI with no TUI library. Key parsing reads byte by byte, because a terminal can deliver several
keys in one chunk.

`fleet attach` in a second terminal does the same thing while the watch keeps
running; a held peer's pane shows a banner with the count of waiting messages.

## 8. Fixes this depends on

- **Sender attribution.** `fleet send` stamps every message `from: user`. `SendParams` gains the sender, taken from
  `FLEET_PEER` when set, so mail a peer sends — headless or during a takeover — is attributed to it.
- **Cursor trust.** The Cursor adapter never passes `--trust`, so a headless turn in an untrusted directory stops at the
  workspace-trust prompt. The adapter passes it. That means a repo's `.cursor` MCP servers and hooks run without the
  prompt. This is accepted because a peer's cwd is always the profile's own checkout or a worktree fleetd made of it:
  the person chose that repo when they wrote the profile.

Both are bugs today and ship separately from this design.

## 9. Parked

How inbound mail reaches a session while a person holds it. Until decided, it queues and is delivered on release; the
watch and the attach banner show the count.

## 10. Proven, and still to prove

A second spike (2026-11-11, `~/dev/fleet-sandbox`, real providers, no daemon) proved:

- The socket can carry `peer.watch` with the changes in §6. A vanished client closes cleanly.
- Claude and Cursor both give text as it arrives, with the options in §6.
- A full-screen program hands the terminal to native `claude` and takes it back, through resize, ctrl-c and a killed
  child, with the two rules in §7.
- Stop then `provider.resume` keeps the same ref on both providers, and the next turn answers from prior history.

Still to prove, when hold and release exist in the daemon:

- Mail queued during a hold is delivered once after release.
- ctrl-c during a takeover in macOS Terminal (the spike could not send it there).

## 11. Delivery

One batch, on one branch, built in this order so each step is usable before the next starts:

1. §8 fixes.
2. Hold and release, stop and start, with `fleet attach`, `fleet release`, `fleet stop`, `fleet start` (§4, §5, §7.2).
3. Display feed and `peer.watch`, with context used on the peer's activity row (§6).
4. `fleet watch`: peer list, detail pane, needs-you strip, action menus (§7, §7.1). `fleet-view` is removed here.
5. The board's answer control (§7.3).

## 12. Testing

- Supervisor: hold at a boundary, hold during the opening turn waits for it, hold with interrupt, release resumes with
  the same ref and sends the handback note and not the brief, release falls back when resume rejects, a restart with a held peer starts nothing for it, mail queued while held is delivered once after release.
- Provider conformance: a provider that declares `display` emits a `turn` line for every `turn.started` and
  `turn.ended`; the Claude and Cursor adapters are checked against recorded streams.
- Daemon: `peer.watch` replays the buffer then streams; a stalled client is dropped and the peer's turn is unaffected.
- Watch: the render and the key handling are pure functions over a state, tested without a terminal, as `fleet-view`'s
  render is today.
- Stop and start: a stopped peer is skipped by start, recovery and assignment and survives a restart; start resumes
  from the ref; the other peers' sessions are untouched throughout.
- Needs you: an open decision and a `waiting_input` peer both appear; answering from the watch and from the board each
  append one answered event, and the PM's next tick sees it with no other signal.
- Peer list: context used comes from the last recorded turn, and a peer with no recorded turn shows none, not zero.
- End to end in a sandbox repo: start a fleet, hold a peer, type one turn in the native CLI, release, and assert the
  next headless turn sees it.
