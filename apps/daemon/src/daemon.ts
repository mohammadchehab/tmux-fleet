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

import { fleetError, peerActor, systemClock, type Actor, type Clock, type PeerId, type Seq } from '@fleet/foundation-core'
import type {
  AppendEvent,
  Decision,
  EventSink,
  Mailbox,
  Message,
} from '@fleet/foundation-contracts'
import type { EventStore } from '@fleet/foundation-store'
import type { PeerRow, DaemonApi, DaemonStatus, PeekedMessage, RoutineRow, DecisionRow } from './rpc.ts'
import type { Profile, PeerProfile } from './profile.ts'
import type { ProfilePaths } from './paths.ts'
import type { Scheduler } from '@fleet/orchestration-routines'
import type { Supervisor } from './sessions.ts'

export interface DaemonDeps {
  readonly profile: Profile
  readonly paths: ProfilePaths
  readonly store: EventStore
  readonly supervisor: Supervisor
  /** Built by `main.ts` from the store, the supervisor and the router (§7). */
  readonly mailbox: Mailbox
  readonly scheduler: Scheduler
  readonly clock?: Clock
  /** Injected so a test states its pid instead of inventing one. */
  readonly pid?: number
}

export interface Daemon extends DaemonApi {
  readonly status: DaemonStatus
  /** For tests and for `down`: is the timer running? */
  readonly running: boolean
}

const ACTOR: Actor = 'user'

export const createDaemon = (deps: DaemonDeps): Daemon => {
  const clock = deps.clock ?? systemClock
  const store = deps.store
  const read = store.reader()
  const append: EventSink['append'] = (batch: readonly AppendEvent[]) => store.append(batch)
  const status: DaemonStatus = {
    profile: deps.profile.profile,
    pid: deps.pid ?? process.pid,
    startedAt: clock.now(),
    socketPath: deps.paths.socketPath,
    storePath: deps.paths.storePath,
  }
  let running = false
  let stopping: Promise<void> | undefined

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
      pending.push(registeredEvent(peer, clock.now()))
    }
    return pending.length === 0 ? [] : append(pending)
  }

  const start = async (): Promise<DaemonStatus> => {
    if (running) return status
    await registerPeers()
    await deps.supervisor.start()
    const ran = await deps.scheduler.start()
    running = true
    if (ran.length > 0) {
      // The scheduler's own events say what ran; this line is for the log a human reads.
      console.error(`fleetd: caught up ${ran.length} routine run(s) on start`)
    }
    return status
  }

  const stop = async (): Promise<void> => {
    await (stopping ??= (async () => {
      // Scheduler first: a routine that is mid-decide must not be handed a peer
      // the supervisor has just stopped (§6, §7).
      deps.scheduler.stop()
      await deps.supervisor.stop()
      running = false
    })())
  }

  const pendingCount = async (peer: PeerId): Promise<number> => {
    const result = await deps.mailbox.pending(peer)
    return result.length
  }

  const peerRows = async (): Promise<readonly PeerRow[]> => {
    const peers = await read.peers.all()
    const declared = new Map(deps.profile.peers.map((peer) => [peer.id, peer]))
    const rows: PeerRow[] = []
    for (const peer of peers) {
      // A peer the profile dropped still shows: it has history, and hiding it
      // would make `fleet ls` disagree with the store.
      rows.push({
        id: peer.peerId,
        role: peer.role,
        provider: peer.providerId,
        state: peer.state,
        pending: await pendingCount(peer.peerId),
        ...(peer.currentSessionId === undefined ? {} : { sessionId: peer.currentSessionId }),
      })
    }
    // A peer the profile declares but `up` has not registered yet (it failed
    // mid-start) is shown as undeclared rather than silently missing.
    for (const peer of declared.values()) {
      if (rows.some((row) => row.id === peer.id)) continue
      rows.push({ id: peer.id, role: peer.role, provider: peer.provider, state: 'offline', pending: 0 })
    }
    return rows
  }

  const routineRows = async (): Promise<readonly RoutineRow[]> => {
    const routines = await read.routines.all()
    return routines.map((routine) => ({
      id: routine.routineId,
      kind: routine.kind,
      state: routine.state,
      runs: routine.runs,
      failures: routine.failures,
      ...(routine.lastRunAt === undefined ? {} : { lastRunAt: routine.lastRunAt }),
    }))
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
      return { status, peers: await peerRows(), routines: await routineRows() }
    },

    async send(input) {
      const result = await deps.mailbox.send({
        to: input.to,
        from: ACTOR,
        kind: input.kind,
        briefVersion: input.briefVersion ?? (await deps.supervisor.briefs.current(input.to)) ?? 0,
        body: input.body,
      })
      if (!result.ok) throw result.error
      return { msgId: result.value }
    },

    async peek(input) {
      // `pending` is the unacked box: what the peer still has to act on, oldest
      // first, which is what `fleet peek` is for (§7). An `ack`ed message is
      // history and reads from the projection instead.
      const pending = await deps.mailbox.pending(input.peer)
      const rows = input.limit === undefined ? pending : pending.slice(-input.limit)
      if (rows.length > 0) return { messages: rows.map(peeked) }
      const all = await read.messages.forPeer(input.peer)
      return { messages: (input.limit === undefined ? all : all.slice(-input.limit)).map(peeked) }
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
      return decisionRow(decision)
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
  }
}

const peeked = (message: Message): PeekedMessage => ({
  msgId: message.msgId,
  from: message.from,
  to: message.to,
  kind: message.kind,
  body: message.body,
  state: message.state,
  sentAt: message.sentAt,
})

const decisionRow = (decision: Decision): DecisionRow => ({
  id: decision.decisionId,
  kind: decision.kind,
  state: decision.state,
  question: decision.question,
  options: decision.options,
  requestedAt: decision.requestedAt,
})

/**
 * The profile declares the peer, so the registration is the user's event: no
 * other actor is honest here — the scheduler did not decide it and the PM has
 * not run yet (§3).
 */
const registeredEvent = (peer: PeerProfile, ts: string): AppendEvent => ({
  type: 'peer.registered',
  ts,
  subject: peer.id,
  actor: 'user',
  data: {
    peerId: peer.id,
    role: peer.role,
    providerId: peer.provider,
    model: peer.model,
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
