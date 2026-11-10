/**
 * The in-memory store, read model, PM and executor the scheduler is tested
 * against. The real store is `foundation/store`'s and not written yet; a routine
 * only reads projections and hands actions to the executor, so fakes are enough
 * to prove the behaviour §6 asks for.
 *
 * `decide` is synchronous here because it is synchronous in the port (§5.3): a
 * Judge question is an action, not an `await`, which is what makes replay a
 * diff of two action lists (§5.4).
 */

import { parse, peerId } from '@fleet/foundation-core'
import type { Seq } from '@fleet/foundation-core'
import {
  eventSchemaFor,
  type ActionExecutor,
  type AppendEvent,
  type DecideRequest,
  type DecideResult,
  type ExecuteRequest,
  type ExecutionReport,
  type FleetEvent,
  type Notification,
  type Peer,
  type PmAction,
  type ProjectManager,
  type PullRequest,
  type ReadModel,
  type Routine,
  type Work,
  type Worktree,
} from '@fleet/foundation-contracts'
import type { EventSink, Timers } from '../../src/scheduler.ts'

export const AT = '2026-11-10T09:00:00.000Z'

/** A clock a test can move, so `durationMs` and every `ts` are stated, not waited for. */
export interface MovableClock {
  now(): string
  millis(): number
  advance(ms: number): void
  set(at: string): void
}

export const movableClock = (at: string = AT): MovableClock => {
  let millis = Date.parse(at)
  return {
    now: () => new Date(millis).toISOString(),
    millis: () => millis,
    advance: (ms) => {
      millis += ms
    },
    set: (next) => {
      millis = Date.parse(next)
    },
  }
}

export interface FakeStore extends EventSink {
  readonly appended: readonly AppendEvent[]
  ofType<T extends AppendEvent['type']>(type: T): readonly Extract<AppendEvent, { type: T }>[]
  failNext(count?: number): void
}

export const fakeStore = (): FakeStore => {
  const appended: AppendEvent[] = []
  let failures = 0
  return {
    appended,
    append: async (batch) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('store is unavailable')
      }
      const seqs: Seq[] = []
      for (const event of batch) {
        appended.push(event)
        seqs.push(appended.length)
      }
      return seqs
    },
    ofType: <T extends AppendEvent['type']>(type: T) =>
      appended.filter((event): event is Extract<AppendEvent, { type: T }> => event.type === type),
    failNext: (count = 1) => {
      failures += count
    },
  }
}

/**
 * The read model, over arrays a test sets. Only the collections a routine's
 * snapshot touches are seeded; the rest are empty, so `snapshot()` still
 * exercises every call it makes in production (§5.2).
 */
export interface FakeRead extends ReadModel {
  /** Replace one collection; everything else keeps its current rows. */
  readonly put: <K extends keyof FakeRows>(rows: Pick<FakeRows, K>) => void
}

export interface FakeRows {
  readonly peers: readonly Peer[]
  readonly routines: readonly Routine[]
  readonly notifications: readonly Notification[]
  /** The `Work` rows a `pr-babysit` nudge is addressed from (§5.1, §6). */
  readonly work: readonly Work[]
  /** The `PR` projection, which is what `pr-babysit` compares an observation against (§10). */
  readonly pullRequests: readonly PullRequest[]
  /** The checkouts `branch-cleanup` may remove, and the three facts that say whether it may (§9). */
  readonly worktrees: readonly Worktree[]
}

const EMPTY: FakeRows = { peers: [], routines: [], notifications: [], work: [], pullRequests: [], worktrees: [] }

export const fakeRead = (rows: Partial<FakeRows> = {}): FakeRead => {
  const current: FakeRows = { ...EMPTY, ...rows }
  return {
    peers: {
      all: async () => current.peers,
      get: async (id) => current.peers.find((peer) => peer.peerId === id),
    },
    sessions: {
      // No sessions are seeded: the scheduler's tests do not read them, and the
      // snapshot's single `all()` is what a routine asks for.
      all: async () => [],
      forPeer: async () => [],
    },
    work: {
      all: async () => current.work,
      get: async (id) => current.work.find((row) => row.workId === id),
    },
    decisions: { all: async () => [], open: async () => [], get: async () => undefined },
    notifications: {
      all: async () => current.notifications,
      get: async (key) => current.notifications.find((row) => row.key === key),
    },
    findings: { all: async () => [] },
    // No questions are seeded: the routines' own tests never read one, and the
    // snapshot asks once so a routine under test sees an empty question log.
    judge: { all: async () => [], get: async () => undefined },
    messages: { all: async () => [], forPeer: async () => [] },
    pullRequests: { all: async () => current.pullRequests },
    worktrees: { all: async () => current.worktrees },
    routines: { all: async () => current.routines },
    // No evals are seeded: no routine compares two runs, and the CLI's `evals
    // compare` reads the real store, not this fake.
    evals: { get: async () => undefined },
    // No builds are seeded: no routine reads the ledger, and the ledger's own
    // suite supplies the reader it needs.
    builds: { find: async () => undefined, get: async () => undefined },
    // No compactions are seeded: no routine reads them yet, and an empty read is
    // what the daemon's `ls` would get from a fleet that has never compacted.
    compactions: { all: async () => [] },
    // §6.2's cost report is not something a routine decides on; no test in this
    // package reads it, so the fake answers the empty report.
    tokens: { all: async () => [] },
    // No activity is seeded either: a routine decides from the log, and the
    // activity row is a reading of it for a person, not an input to a rule.
    activity: { all: async () => [] },
    put: (next) => {
      Object.assign(current, next)
    },
  }
}

/** A projection row for a routine that has run. `lastRunAt` is what catch-up is judged on. */
export const routineRow = (fields: Partial<Routine> & Pick<Routine, 'routineId' | 'kind'>): Routine => ({
  trigger: 'heartbeat',
  state: 'finished',
  runs: 1,
  failures: 0,
  ...fields,
})

export const NO_ACTIONS: DecideResult = { actions: [], inputsHash: 'hash-of-nothing' }

export interface FakePm extends ProjectManager {
  readonly requests: readonly DecideRequest[]
  /** What the next `decide` answers; a function so a test can make it depend on the request. */
  answers(result: DecideResult | ((request: DecideRequest) => DecideResult)): void
  failNext(error: Error): void
}

export const fakePm = (): FakePm => {
  const requests: DecideRequest[] = []
  let answer: (request: DecideRequest) => DecideResult = () => NO_ACTIONS
  let failure: Error | undefined
  return {
    requests,
    decide: (request) => {
      requests.push(request)
      if (failure !== undefined) {
        const thrown = failure
        failure = undefined
        throw thrown
      }
      return answer(request)
    },
    answers: (result) => {
      answer = typeof result === 'function' ? result : () => result
    },
    failNext: (error) => {
      failure = error
    },
  }
}

/**
 * The executor (§10). It records what it was asked to do and can fail the first
 * N actions, which is what `actionsFailed` is about: a decision the PM made and
 * the world refused is not the same as a decision the PM never made (§5.2, §6).
 */
export interface FakeExecutor extends ActionExecutor {
  readonly requests: readonly ExecuteRequest[]
  failNext(count: number): void
}

export const fakeExecutor = (): FakeExecutor => {
  const requests: ExecuteRequest[] = []
  let failures = 0
  return {
    requests,
    execute: async (request) => {
      requests.push(request)
      const outcomes = request.actions.map((action, index) => ({
        action,
        ok: index >= failures,
        seqs: [] as readonly Seq[],
        ...(index >= failures ? {} : { error: 'the executor refused this action' }),
      }))
      failures = Math.max(0, failures - request.actions.length)
      const report: ExecutionReport = {
        outcomes,
        executed: outcomes.filter((outcome) => outcome.ok).length,
        failed: outcomes.filter((outcome) => !outcome.ok).length,
      }
      return report
    },
    failNext: (count) => {
      failures = count
    },
  }
}

export interface FakeTimers extends Timers {
  readonly installed: readonly { readonly callback: () => void; readonly everyMs: number }[]
  readonly cleared: number
  /** Run every installed interval callback once, as the timer would. */
  fire(): Promise<void>
}

export const fakeTimers = (): FakeTimers => {
  const installed: { callback: () => void; everyMs: number }[] = []
  let cleared = 0
  return {
    installed,
    get cleared() {
      return cleared
    },
    setInterval: (callback, everyMs) => {
      installed.push({ callback, everyMs })
      return installed.length
    },
    clearInterval: () => {
      cleared += 1
    },
    fire: async () => {
      for (const entry of installed) entry.callback()
      // The callbacks start a promise and drop it; one turn of the microtask
      // queue is enough for the tick's appends to land.
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

/** The events of one run, in order, as the store saw them. */
export const runShape = (store: FakeStore): readonly string[] =>
  store.appended.map((event: AppendEvent): string => event.type as string)

export const fleetEventOf = <T extends AppendEvent['type']>(store: FakeStore, type: T): readonly FleetEvent[] =>
  store.ofType(type) as unknown as readonly FleetEvent[]

/**
 * The event the wake path is handed. Built through the registry's own schema,
 * so a test cannot wake a routine with an event the store would have refused.
 */
export const peerStateChanged = (seq: number, peer: string = 'engineer-1'): FleetEvent =>
  parse(eventSchemaFor('peer.state_changed')!, {
    seq,
    ts: AT,
    type: 'peer.state_changed',
    subject: peer,
    actor: `peer:${peer}`,
    data: { peerId: peer, state: 'idle' },
  }) as FleetEvent

export const purgeStarted = (seq: number): FleetEvent =>
  parse(eventSchemaFor('purge.started')!, {
    seq,
    ts: AT,
    type: 'purge.started',
    subject: 'engineer-1',
    actor: 'scheduler',
    data: { peerId: 'engineer-1', sessionId: 'ses_0123456789abcdef', contextTokens: 180_000, contextLimit: 200_000 },
  }) as FleetEvent

/**
 * One real action, for the PM fake to decide. The scheduler's tests only count
 * actions, so the cheapest valid variant stands in for any of them.
 */
export const flagCapacity = (): PmAction => ({
  kind: 'flag_capacity',
  causedBy: [],
  peerId: parse(peerId(), 'engineer-1'),
  reason: 'at capacity',
})

/** A decision of `count` real actions — so `routine.finished.actions` is a count of something. */
export const decided = (count = 1, inputsHash: string = 'hash-of-one'): DecideResult => ({
  actions: Array.from({ length: count }, flagCapacity),
  inputsHash,
})

/** Standup is an action too (§6.1): the body decides it is due, the executor renders it. */
export const renderStandup = (date: string = '2026-11-10'): PmAction => ({
  kind: 'render_standup',
  causedBy: [],
  date,
})
