/**
 * fleetd (architecture §2): the one place the groups are wired together.
 *
 * Everything below the daemon is a package that knows its own job and nothing
 * about its neighbours (§1.1). This file is where they meet, and the only place
 * that may hold a concrete provider (§2, "inject concrete providers only here").
 * It owns three things and delegates the rest:
 *
 * - **The store.** It is opened once (`main.ts`), handed to the Mailbox and the
 *   scheduler as the narrow `EventSink`/`ReadModel` ports they already take,
 *   and never passed around whole.
 * - **The loops.** `up()` starts the supervisor and the scheduler; `down()`
 *   stops both, in that order, so nothing is delivered while the scheduler is
 *   still deciding.
 * - **The API.** `DaemonApi` over the store and the Mailbox: `up`, `down`, `ls`,
 *   `send`, `peek`, `decide` (§2's socket, §7's only way to a peer).
 *
 * What it deliberately does *not* do is decide anything. `decide` on a decision
 * answers it by appending `decision.answered` — the PM reads that on its next
 * tick and decides what follows (§5.2). A daemon that acted on an answer
 * directly would be a second PM.
 */

import {
  fleetError,
  peerActor,
  systemClock,
  toFleetError,
  type Actor,
  type Clock,
  type PeerId,
  type ProfilePaths,
  type Seq,
} from '@fleet/foundation-core'
import type {
  AppendEvent,
  BuildsParams,
  BuildsResult,
  DaemonApi,
  DaemonStatus,
  Decision,
  EvalsParams,
  EvalsResult,
  EventSink,
  FleetEvent,
  Mailbox,
  NoteParams,
  NoteResult,
  ReplayParams,
  ReplayResult,
  Work,
  WorkState,
} from '@fleet/foundation-contracts'
import { daemonProtocolVersion } from '@fleet/foundation-contracts'
import type { EventStore } from '@fleet/foundation-store'
import type { BuildLedger } from '@fleet/orchestration-ledger'
import { effortWarnings, modelFor, purgeLimitsOf, type Profile, type ProfileProvider, type PeerProfile } from '../config/profile.ts'
import type { Scheduler } from '@fleet/orchestration-routines'
import type { Supervisor } from '../execution/sessions.ts'
import { catchUpWork } from '../execution/work-sync.ts'

export interface DaemonDeps {
  readonly profile: Profile
  readonly paths: ProfilePaths
  readonly store: EventStore
  /**
   * How the daemon writes (§5.2). `compose.ts` passes the waking sink, so a
   * `peer.registered` from `up` wakes the routines like any other append; the
   * default is the plain store, for a test that does not care about waking.
   */
  readonly append?: EventSink['append']
  readonly supervisor: Supervisor
  /** Built by `main.ts` from the store, the supervisor and the router (§7). */
  readonly mailbox: Mailbox
  readonly scheduler: Scheduler
  /**
   * §11's ledger. Composed by `compose.ts` from the profile's `builds` block,
   * so the fleet has one answer per `(repo, sha, task)` rather than one per
   * caller: two peers asking for the same build wait on the same promise.
   */
  readonly ledger: BuildLedger
  readonly clock?: Clock
  /** Injected so a test states its pid instead of inventing one. */
  readonly pid?: number
  /**
   * What a provider can do, for the `fleet up` warnings (TASK-12). `compose.ts`
   * wires the map it built; absent means a daemon that wired no providers of its
   * own — a test — and then there is no capability to contradict a profile.
   */
  readonly providerCapabilities?: (provider: ProfileProvider) => { readonly effort: boolean } | undefined
  /**
   * shared-fleet.md §2.2: the loop that publishes this fleet's pace, when the
   * profile has a `coord` block. Started with the fleet and stopped first, so a
   * fleet that is down stops telling the pool it has idle peers.
   */
  readonly coordination?: { start(): void; stop(): void }
}

export interface Daemon extends DaemonApi {
  readonly status: DaemonStatus
  /** For tests and for `down`: is the timer running? */
  readonly running: boolean
}

const ACTOR: Actor = 'user'

/**
 * The states in which a Work is still the assignee's (§5.1). `assigned` and
 * `in_progress` are the obvious two; `in_review`, `mergeable` and `blocked` are
 * in the list because the peer has not let go of the Work at any of them — a
 * peer that opened a PR is still the one answering questions about it, and a
 * blocked peer is the one that says what it is blocked on. `merged`, `cleaned`
 * and `cancelled` are over, and `proposed`/`ready` have no assignee at all.
 */
const heldWorkStates: ReadonlySet<WorkState> = new Set(['assigned', 'in_progress', 'in_review', 'mergeable', 'blocked'])

export const createDaemon = (deps: DaemonDeps): Daemon => {
  /** A peer the fleet has, or `not_found` naming it: the same answer `peek` gives a typo. */
  const requirePeer = async (peerId: PeerId): Promise<void> => {
    if ((await deps.store.reader().peers.get(peerId)) === undefined) {
      throw fleetError('not_found', `no peer ${String(peerId)} in this fleet; 'fleet ls' lists the peers`, {
        details: { peerId: String(peerId) },
      })
    }
  }

  const clock = deps.clock ?? systemClock
  const store = deps.store
  const read = store.reader()
  const append: EventSink['append'] = deps.append ?? ((batch: readonly AppendEvent[]) => store.append(batch))
  // What the profile asked for and a provider cannot honour (TASK-12). Said once,
  // here, which is where `fleet up` reads it; a fleet is not refused over a
  // reasoning level, but it does not get to look like it was honoured either.
  const capabilityOf = deps.providerCapabilities ?? (() => undefined)
  const warnings = effortWarnings(deps.profile, capabilityOf)
  const status: DaemonStatus = {
    profile: deps.profile.profile,
    pid: deps.pid ?? process.pid,
    startedAt: clock.now(),
    socketPath: deps.paths.socketPath,
    storePath: deps.paths.storePath,
    protocolVersion: daemonProtocolVersion,
    purgeContextRatio: purgeLimitsOf(deps.profile).contextRatio,
    ...(warnings.length === 0 ? {} : { warnings }),
  }
  let running = false
  let stopping: Promise<void> | undefined
  let starting: Promise<DaemonStatus> | undefined

  /**
   * §3: a peer exists because `peer.registered` says so, not because a file
   * says so. `up` registers whoever the profile declares and the store has not
   * seen yet, so `fleet up` twice is one registration and a peer dropped from
   * the profile keeps its history rather than being deleted.
   */
  const registerPeers = async (): Promise<readonly Seq[]> => {
    const pending: AppendEvent[] = []
    for (const peer of deps.profile.peers) {
      const existing = await read.peers.get(peer.id)
      if (existing !== undefined) continue
      pending.push(registeredEvent(deps.profile, peer, clock.now()))
    }
    return pending.length === 0 ? [] : append(pending)
  }

  const startOnce = async (): Promise<DaemonStatus> => {
    await registerPeers()
    await deps.supervisor.start()
    const ran = await deps.scheduler.start()
    // After `scheduler.start()`, never before: the waking sink's scheduler is
    // late-bound, so a write made while the scheduler is still coming up would be
    // committed and never woken (`wake.ts`) — which is the same stuck Work this is
    // here to clear, only harder to see. Before `running = true`, so a failed
    // catch-up leaves the daemon down and a second `up` retries it, rather than
    // reporting a fleet that is caught up when it is not.
    const caughtUp = await catchUpWork({ read, append, clock })
    deps.coordination?.start()
    running = true
    if (ran.length > 0) {
      // The scheduler's own events say what ran; this line is for the log a human reads.
      console.error(`fleetd: caught up ${ran.length} routine run(s) on start`)
    }
    if (caughtUp.length > 0) {
      console.error(`fleetd: caught up ${caughtUp.length} work transition(s) on start`)
    }
    return status
  }

  /**
   * A second `up` while the first is still coming up joins it: `running` only
   * flips once catch-up is done, so without this both calls would start every
   * peer's session. A failed start clears the slot, so the next `up` retries.
   *
   * An `up` begins by forgetting the last stop, which is the moment that memo
   * starts describing a state that no longer exists (TASK-46). It is cleared
   * here, before the first await, and not beside `running = true` where it used
   * to be: an `up` that failed half-way — after `supervisor.start()`, say — left
   * the previous, already-resolved memo in place, so the `down` that followed
   * awaited it, resolved at once, stopped nothing, and left the peers that up
   * had started running (TASK-68 3b). A plain second `down` still joins the
   * first stop, because only an `up` clears this.
   */
  const start = async (): Promise<DaemonStatus> => {
    if (running) return status
    if (starting !== undefined) return starting

    const downInFlight = stopping
    stopping = undefined

    const attempt = (async () => {
      // A `down` that is still stopping finishes first: the sessions this start
      // creates must not be the ones that stop is about to take away.
      if (downInFlight !== undefined) await downInFlight.catch(() => undefined)
      return startOnce()
    })()
    starting = attempt
    try {
      return await attempt
    } finally {
      if (starting === attempt) starting = undefined
    }
  }

  /**
   * A second `down` while the first is still stopping joins it.
   *
   * A `down` that arrives while an `up` is still starting waits for that `up` to
   * finish and then stops what it started (TASK-68 3c). The two used to run
   * concurrently: the stop finished first, `startOnce` then set `running = true`
   * and cleared the memo, so `down` had returned "stopped" for a fleet whose
   * peers were up — and the next `up` short-circuited on `running` and started
   * nothing.
   *
   * A stop that throws is not a stop: the slot is cleared so the next `down`
   * tries again rather than replaying the failure, which is what a memoised
   * rejected promise did (TASK-68 3a). A stop that worked stays memoised.
   */
  const stop = async (): Promise<void> => {
    if (stopping !== undefined) return stopping

    // Read once, at the moment this stop begins: a later `up` queues behind *this*
    // stop, so capturing it again later would put the two in each other's way.
    const upInFlight = starting
    const attempt = (async () => {
      // An `up` that is still starting is stopped afterwards whatever it did: if it
      // failed part-way, the sessions it did start are exactly what this stops.
      if (upInFlight !== undefined) await upInFlight.catch(() => undefined)
      // The pool first: a fleet going down must not publish its peers as idle
      // while the supervisor stops them (shared-fleet.md §3). Then the scheduler:
      // a routine that is mid-decide must not be handed a peer the supervisor has
      // just stopped (§6, §7).
      deps.coordination?.stop()
      deps.scheduler.stop()
      await deps.supervisor.stop()
      running = false
    })()
    stopping = attempt
    // Registered before the caller awaits `attempt`, so the slot is clear by the
    // time a rejection reaches it.
    attempt.catch(() => {
      if (stopping === attempt) stopping = undefined
    })
    return attempt
  }

  /**
   * Hand a peer's box to its session, right after a message joined it (§7).
   *
   * `no_session` is the queued case, not a failure: a peer that is registered
   * but not running keeps the message pending, and the Mailbox replays it into
   * the session that resumes it. Everything else is a delivery the user asked
   * for that did not happen — a provider that refused the turn, a session being
   * purged — so it is logged, and the message still stays in the box for the
   * next attempt rather than failing the send the user already completed.
   */
  const deliverNow = async (peer: PeerId): Promise<void> => {
    try {
      const outcome = await deps.mailbox.deliver(peer)
      if (!outcome.ok) {
        console.error(`fleetd: delivery to ${peer} failed and the message stays pending: ${outcome.error.message}`)
        return
      }
      const stuck = outcome.value.failures.filter((failure) => failure.reason !== 'no_session')
      if (stuck.length > 0) {
        const reasons = [...new Set(stuck.map((failure) => failure.reason))].join(', ')
        console.error(`fleetd: ${String(stuck.length)} message(s) for ${peer} stay pending: ${reasons}`)
      }
    } catch (thrown) {
      // The message is the store's already; a broken delivery must not turn a
      // completed send into an error the caller would retry.
      console.error(`fleetd: delivery to ${peer} threw and the message stays pending: ${toFleetError(thrown, 'internal').message}`)
    }
  }

  return {
    get status() {
      return status
    },
    get running() {
      return running
    },

    up: start,

    async down() {
      await stop()
      return { stopped: true } as const
    },

    async ls() {
      // Everything here is a projection: `fleet ls` shows what the store knows,
      // not a shape this file invented, so a row that gained a field in §3 is a
      // row that gained a field in the CLI (§2).
      return {
        status,
        peers: await read.peers.all(),
        routines: await read.routines.all(),
        decisions: await read.decisions.open(),
        compactions: await read.compactions.all(),
        tokens: await read.tokens.all(),
        activity: await read.activity.all(),
      }
    },

    async work() {
      // One projection read, exactly: a board's rows are the store's rows, so
      // this reshapes nothing and filters nothing. A board that disagreed with
      // `fleet ls` about the fleet would be a board rendering a shape of its own
      // (§2).
      return { work: await read.work.all() }
    },

    async send(input) {
      // The brief version the message is written against is resolved here, not
      // defaulted: `0` is not a brief version, and a store that refuses to
      // append one is a better error than a message the peer cannot judge (§7).
      // A running session knows its brief; a peer that is not running still has
      // the version the projection last recorded; anything else is not a peer
      // this fleet can address.
      const briefVersion =
        input.briefVersion ??
        (await deps.supervisor.briefs.current(input.to)) ??
        (await read.peers.get(input.to))?.briefVersion
      if (briefVersion === undefined || briefVersion < 1) {
        throw fleetError('not_found', `no peer ${String(input.to)} with a brief to send to`, {
          details: { peerId: String(input.to) },
        })
      }
      // A sender that is not a peer of this fleet is refused rather than recorded:
      // `peer:<typo>` on a message would read as a peer that never existed (§7).
      if (input.from !== undefined && (await read.peers.get(input.from)) === undefined) {
        throw fleetError('not_found', `no peer ${String(input.from)} in this fleet to send from`, {
          details: { peerId: String(input.from) },
        })
      }
      const result = await deps.mailbox.send({
        to: input.to,
        from: input.from === undefined ? ACTOR : peerActor(input.from),
        kind: input.kind,
        briefVersion,
        body: input.body,
      })
      if (!result.ok) throw result.error
      // §7: the message is the store's and the Mailbox is how a peer is reached,
      // so a live peer gets the turn now. Awaiting it is what makes `fleet send`
      // followed by `fleet peek` show what actually happened.
      await deliverNow(input.to)
      return { msgId: result.value }
    },

    async peek(input) {
      // A peer this fleet does not have is a typo, not an empty mailbox: both
      // render as "no messages", and only one of them is worth acting on.
      if ((await read.peers.get(input.peer)) === undefined) {
        throw fleetError('not_found', `no peer ${String(input.peer)} in this fleet; 'fleet ls' lists the peers`, {
          details: { peerId: String(input.peer) },
        })
      }
      // `pending` is the unacked box: what the peer still has to act on, oldest
      // first, which is what `fleet peek` is for (§7). An `ack`ed message is
      // history and reads from the projection instead. Both are `Message` — the
      // same row the CLI renders — so nothing is reshaped on the way out.
      // A limit of zero asks for nothing, and "nothing" is an empty answer —
      // `slice(-0)` is `slice(0)`, the whole box, so the two slices below
      // cannot express it. It also cannot fall through: an empty pending slice
      // would read as an empty box and return the whole history it is not in.
      if (input.limit === 0) return { messages: [] }
      const pending = await deps.mailbox.pending(input.peer)
      const rows = input.limit === undefined ? pending : pending.slice(-input.limit)
      if (rows.length > 0) return { messages: rows }
      const all = await read.messages.forPeer(input.peer)
      return { messages: input.limit === undefined ? all : all.slice(-input.limit) }
    },

    async decide(input) {
      const decision = await read.decisions.get(input.id)
      if (decision === undefined) {
        throw fleetError('not_found', `no decision ${input.id} to answer`)
      }
      if (decision.state !== 'open') {
        throw fleetError('conflict', `decision ${input.id} is ${decision.state}, not open`)
      }
      await append([answeredEvent(input.id, decision, input.decision, input.note, clock.now())])
      // The event is written by this call, the row it produces by the
      // projection: answering with the row as it now stands is what makes the
      // reply say `answered` (§6.1) instead of the question's last state.
      return (await read.decisions.get(input.id)) ?? decision
    },

    async evals(input: EvalsParams): Promise<EvalsResult> {
      // §17's comparison is two reads of the projections and nothing else: no
      // event walk, and no verdict computed here — the CLI puts the two side by
      // side, so the daemon never has to decide what "worse" means.
      const run = await read.evals.get(input.runId)
      if (run === undefined) {
        throw fleetError('not_found', `no eval run ${String(input.runId)}; the projections hold every run the log recorded`, {
          details: { runId: String(input.runId) },
        })
      }
      return run
    },

    async builds(input: BuildsParams): Promise<BuildsResult> {
      // §11: the ledger asks the projection first, so the second request for a
      // triple costs one read and no process. What the daemon adds is nothing —
      // it does not decide whether a build is worth running, and a daemon that
      // did would be a second ledger.
      return deps.ledger.request(input)
    },

    async usage(input) {
      // The hook runs as the peer, so the peer is the actor; an unknown peer is refused rather than
      // recorded against nothing (the `token-report` groups by peer).
      if ((await read.peers.get(input.peerId)) === undefined) {
        throw fleetError('not_found', `no peer ${input.peerId} to record usage for`)
      }
      await append([
        {
          type: 'turn.usage_recorded',
          ts: clock.now(),
          subject: input.peerId,
          actor: peerActor(input.peerId),
          data: input,
        },
      ])
      return { recorded: true } as const
    },

    async note(input: NoteParams): Promise<NoteResult> {
      // A note names the peer, not the Work (§5.1): what a peer is working on is
      // the PM's decision, so the daemon reads it off the Work rather than
      // trusting the caller to name it. That is also why the answer carries the
      // workId — a peer that did not name one learns which Work it spoke about.
      const held: Work[] = (await read.work.all()).filter(
        (row) => row.assignee === input.peerId && heldWorkStates.has(row.state),
      )
      const [work, ...rest] = held
      if (work === undefined) {
        throw fleetError('not_found', `peer ${String(input.peerId)} has no Work to note on`, {
          details: { peerId: String(input.peerId) },
        })
      }
      if (rest.length > 0) {
        // Two held Works is a fleet that has lost track, not a note to guess at:
        // picking one would put the peer's words on the wrong card.
        throw fleetError(
          'conflict',
          `peer ${String(input.peerId)} holds ${String(held.length)} Works (${held.map((row) => String(row.workId)).join(', ')}); a note cannot say which`,
          { details: { peerId: String(input.peerId), workIds: held.map((row) => String(row.workId)) } },
        )
      }
      await append([
        {
          type: 'work.noted',
          ts: clock.now(),
          subject: work.workId,
          actor: peerActor(input.peerId),
          data: { workId: work.workId, peerId: input.peerId, phase: input.phase, body: input.body },
        },
      ])
      return { workId: work.workId, phase: input.phase }
    },

    async replay(input): Promise<ReplayResult> {
      // §5.4. A `to` with no `from` is a typo with a big blast radius — the
      // reading below would rebuild every projection — so it is refused rather
      // than read as "rebuild".
      if (input.to !== undefined && input.from === undefined) {
        throw fleetError('invalid_input', '`to` names the end of a window; give a `from` seq as well, or neither to rebuild')
      }
      if (input.from === undefined) {
        // One transaction inside the store, so no reader sees a half-built read
        // model; `health` is the log's own count, not a claim about the rows.
        await store.rebuild()
        const health = await store.health()
        return { mode: 'rebuild', events: health.events, latestSeq: health.latestSeq }
      }
      // The window is a read, so it works while the daemon is running: this is
      // the debugging half, and a person reading a tick should not have to stop
      // the fleet to see it.
      const events: FleetEvent[] = []
      for await (const event of store.iterate(input.from, input.to)) events.push(event)
      return { mode: 'window', events }
    },

    // watch-and-attach §4, §7.2. The person at the socket is the actor: a hold
    // is a person's decision, and the attach client is how they make it.
    async peerHold(input, signal) {
      await requirePeer(input.peerId)
      return deps.supervisor.hold(input.peerId, {
        ...(input.now === undefined ? {} : { now: input.now }),
        by: ACTOR,
        ...(signal === undefined ? {} : { signal }),
      })
    },

    async peerRelease(input) {
      await requirePeer(input.peerId)
      return deps.supervisor.release(input.peerId)
    },

    async peerStop(input, signal) {
      await requirePeer(input.peerId)
      return deps.supervisor.stopPeer(input.peerId, {
        ...(input.now === undefined ? {} : { now: input.now }),
        by: ACTOR,
        ...(signal === undefined ? {} : { signal }),
      })
    },

    async peerInterrupt(input) {
      await requirePeer(input.peerId)
      return { peerId: input.peerId, interrupted: await deps.supervisor.interrupt(input.peerId) }
    },

    async peerStart(input) {
      await requirePeer(input.peerId)
      return deps.supervisor.startPeer(input.peerId)
    },

    async eventsAppend(input) {
      // §17: the eval runner is dev tooling and may not import this app, and the
      // store has one writer, so a run hands its events over the socket instead
      // of opening the db a second time. The contract has already refused
      // anything that is not `eval.*`; what is left is the store's own
      // validation, which is the real gate — an event that does not fit its
      // schema fails here, before it can reach a projection.
      return { seqs: await append(input.events) }
    },
  }
}

/**
 * The profile declares the peer, so the registration is the user's event: no
 * other actor is honest here — the scheduler did not decide it and the PM has
 * not run yet (§3).
 */
const registeredEvent = (profile: Profile, peer: PeerProfile, ts: string): AppendEvent => ({
  type: 'peer.registered',
  ts,
  subject: peer.id,
  actor: 'user',
  data: {
    peerId: peer.id,
    role: peer.role,
    providerId: peer.provider,
    // The role's model when the peer names none (TASK-12): `peer.registered`
    // carries a concrete model, and the event is the peer's identity, not the
    // profile's shorthand.
    model: modelFor(profile, peer),
    permissionMode: peer.permissionMode ?? 'default',
  },
})

/**
 * `fleet decide` is the user answering (§6.1), so the event says `source:
 * 'user'` with no model and no duration. `option` carries the answer when the
 * decision was a choice — and it must be one of the options the question
 * offered, which is checked here rather than left for the PM to notice.
 */
const answeredEvent = (
  id: Decision['decisionId'],
  decision: Decision,
  answer: string,
  note: string | undefined,
  ts: string,
): AppendEvent => {
  const isChoice = decision.options.length > 0
  if (isChoice && !decision.options.includes(answer)) {
    throw fleetError(
      'invalid_input',
      `decision ${id} offers ${decision.options.join(', ')}; "${answer}" is not one of them`,
    )
  }
  return {
    type: 'decision.answered',
    ts,
    subject: id,
    actor: 'user',
    data: {
      decisionId: id,
      source: 'user',
      ...(isChoice ? { option: answer } : {}),
      ...(note === undefined ? {} : { text: note }),
      durationMs: 0,
    },
  }
}
