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

**RPC.** `peer.hold { peerId, now? } -> { sessionRef, providerId, cwd, model }`, `peer.release { peerId }`. `peer.hold`
on a held peer returns the same answer, so reopening a session whose terminal died is the same call.

**Resume failing.** If `provider.resume` rejects on release, the supervisor falls back to a fresh start with the state
file, as recovery does today, and records the reason on `peer.released`. The peer is never left held with nobody
holding it.

## 5. Attach

`fleet attach <peer> [--now]` is a client of §4.

1. Call `peer.hold`. Print what it is waiting for when the peer is mid-turn.
2. Run the provider's CLI in the foreground, in the peer's `cwd`:
   - Claude: `claude --resume <sessionRef> --model <model>`.
   - Cursor: `cursor-agent --resume <chatId> --mode plan --model <model>`.
3. The environment is built from nothing: the same allowlist and values `envFor` gives the headless session
   (`FLEET_PEER`, `FLEET_SOCKET`, `FLEET_ROLE`, provider credentials), plus `TERM`, `HOME`, `PATH` and locale. Nothing
   else is inherited.
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
peer state changes, mail sent and delivered, judge decisions — so the view does not poll.

The framing stays newline-delimited JSON on the same socket. What changes:

- A second message kind beside the one response: stream frames `{ id, stream: 'line' | 'end', ... }`.
- A dispatch path whose handler returns an async iterable.
- One connection per watch. A stream on a shared connection would block every request queued behind it, and today's
  clients close the socket on the first line.

A slow or stalled client is dropped, never waited for. Today's server ignores what `write()` returns, and a stalled
client then buffers without bound (9 MB in 2 seconds in the spike). So: when `write()` returns false, or the socket's
buffered length passes a cap, the daemon destroys that socket; on `close` it ends the iterator. The feed must not be
able to slow a peer or grow the daemon.

## 7. The watch program

`fleet watch` is one terminal program. It replaces the tmux grid, because a shared selection cannot span separate panes.
`fleet watch --once` prints the table and exits, as `fleet-view --once` does today.

```
 fleet watch ── profile ── 4 peers                         ↑↓ select  ⏎ actions  q quit
┌──────────────────┬──────────────────────────────────────────────────────────────────┐
│ PEERS            │ engineer-1 ── working ── claude/opus ── TASK-142                 │
│                  │──────────────────────────────────────────────────────────────────│
│ ▶ engineer-1  ●  │ ✉ in  pm: "refactor Mailbox.acquire"                             │
│   engineer-2  ○  │ Reading the lease code first.                                    │
│   architect   ✋  │ ● Read  src/mailbox.ts                                           │
│   pm          ◆  │ ● Edit  src/mailbox.ts                                           │
└──────────────────┴──────────────────────────────────────────────────────────────────┘
```

Keys: up and down move the selection, Enter opens the actions for the selected peer, `q` quits. No key reaches a peer.

Actions for a running peer:

- **Take over when this turn ends** — `peer.hold`.
- **Take over now** — `peer.hold { now: true }`.
- **Interrupt the turn, stay headless** — the existing interrupt.
- **Send a message** — an ordinary Mailbox message from the person.

Actions for a held peer: **Reopen the native session**, **Release back to fleetd**.

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
  workspace-trust prompt. The adapter passes it.

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

## 11. Order of delivery

1. §8 fixes.
2. Hold and release, with `fleet attach` and `fleet release` (§4, §5). Usable on its own.
3. Display feed and `peer.watch` (§6).
4. `fleet watch` with the action menu (§7). `fleet-view` is removed when this lands.

## 12. Testing

- Supervisor: hold at a boundary, hold during the opening turn waits for it, hold with interrupt, release resumes with
  the same ref and sends the handback note and not the brief, release falls back when resume rejects, a restart with a held peer starts nothing for it, mail queued while held is delivered once after release.
- Provider conformance: a provider that declares `display` emits a `turn` line for every `turn.started` and
  `turn.ended`; the Claude and Cursor adapters are checked against recorded streams.
- Daemon: `peer.watch` replays the buffer then streams; a stalled client is dropped and the peer's turn is unaffected.
- Watch: the render and the key handling are pure functions over a state, tested without a terminal, as `fleet-view`'s
  render is today.
- End to end in a sandbox repo: start a fleet, hold a peer, type one turn in the native CLI, release, and assert the
  next headless turn sees it.
