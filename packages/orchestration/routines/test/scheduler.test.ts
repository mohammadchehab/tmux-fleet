/**
 * The scheduler's promises (architecture §6), one test each: it registers from
 * config, every run is an event, a run is a decision and its execution, a miss
 * is caught up on restart, a routine does not overlap itself, and the clock is
 * the one it is given.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RoutineKind } from '@fleet/foundation-contracts'
import { createScheduler, type SchedulerDeps } from '../src/scheduler.ts'
import type { RoutineBody, RoutineFactory, RoutineOutcome } from '../src/routine.ts'
import {
  AT,
  NO_ACTIONS,
  decided,
  fakeExecutor,
  fakePm,
  fakeRead,
  fakeStore,
  fakeTimers,
  movableClock,
  peerStateChanged,
  purgeStarted,
  routineRow,
} from './support/fakes.ts'

const fixedClock = (at: string) => movableClock(at)

/** What a hand-written body returns; the scheduler's tests are not `runTick`'s. */
const outcome = (actions: number, actionsFailed = 0): RoutineOutcome => ({
  actions,
  actionsFailed,
  inputsHash: `hash-of-${actions}`,
})

/**
 * The first entry of a list these tests have just asserted is non-empty.
 * `noUncheckedIndexedAccess` makes `[0]` a `T | undefined`, and reading it as a
 * `T` should be said out loud once — with a message that names the missing
 * record instead of a TypeError three lines later.
 */
const headOf = <T>(items: readonly T[], what: string): T => {
  const [head] = items
  assert.ok(head !== undefined, `expected at least one ${what}`)
  return head
}

interface Harness {
  readonly deps: SchedulerDeps
  readonly store: ReturnType<typeof fakeStore>
  readonly pm: ReturnType<typeof fakePm>
  readonly executor: ReturnType<typeof fakeExecutor>
  readonly read: ReturnType<typeof fakeRead>
  readonly timers: ReturnType<typeof fakeTimers>
  readonly clock: ReturnType<typeof movableClock>
}

const harness = (overrides: Partial<SchedulerDeps> = {}): Harness => {
  const store = fakeStore()
  const pm = fakePm()
  const executor = fakeExecutor()
  const read = fakeRead()
  const timers = fakeTimers()
  const clock = fixedClock(AT)
  const deps: SchedulerDeps = {
    store,
    read,
    pm,
    executor,
    clock,
    timers,
    config: {},
    ...overrides,
  }
  return { deps, store, pm, executor, read, timers, clock }
}

/** A body that records its runs and answers `actions`. */
const recordingFactory = (
  kind: RoutineKind,
  runs: { routineId: string; trigger: string; at: string }[],
  actions: number = 1,
): RoutineFactory => {
  return (): RoutineBody => ({
    kind,
    run: async (context) => {
      runs.push({ routineId: context.routineId, trigger: context.trigger, at: context.at })
      return outcome(actions)
    },
  })
}

/** The routine kinds a run was decided for, in the order the PM saw them. */
const decidedFor = (pm: ReturnType<typeof fakePm>): readonly (string | undefined)[] =>
  pm.requests.map((request) => request.tick?.kind)

describe('registered from config, nothing hand-wired', () => {
  it('installs the four phase 1 bodies and reports the rest still waiting for one', () => {
    const { deps } = harness()
    const scheduler = createScheduler(deps)
    assert.deepEqual([...scheduler.plan.installed].sort(), ['dispatch', 'keep-busy', 'reconcile', 'standup'])
    assert.deepEqual(
      [...scheduler.plan.unimplemented].sort(),
      // `tracker-sync`, `pr-babysit` and `branch-cleanup` are bodies this package
      // ships but does not install: `apps/daemon` registers each, because only it
      // holds the tracker, the forge and the worktree manager (§1.1).
      ['branch-cleanup', 'notify', 'pr-babysit', 'security-scan', 'tracker-sync', 'worktree-gc'],
    )
  })

  it('does not run a routine the profile disabled', async () => {
    const { deps, pm, store } = harness({ config: { standup: { enabled: false } } })
    const scheduler = createScheduler(deps)
    await scheduler.start()
    // reconcile and keep-busy and dispatch are on; standup and worktree-gc are off.
    assert.equal(decidedFor(pm).includes('standup'), false)
    assert.equal(store.ofType('routine.started').some((event) => event.data.kind === 'standup'), false)
  })

  it('never runs a configured routine that has no body', async () => {
    const { deps, pm } = harness()
    const scheduler = createScheduler(deps)
    await scheduler.start()
    const ran = new Set(decidedFor(pm))
    assert.equal(ran.has('pr-babysit'), false)
    assert.equal(ran.has('notify'), false)
  })
})

describe('every run is an event', () => {
  it('writes routine.started then routine.finished, stamped by the injected clock', async () => {
    const { deps, pm, store, clock } = harness()
    pm.answers(decided(1))
    const scheduler = createScheduler(deps)
    clock.advance(250)
    const records = await scheduler.tick()
    assert.ok(records.length > 0)
    const first = headOf(records, 'record')
    assert.deepEqual(
      store.ofType('routine.started').slice(0, 1).map((event) => [event.type, event.ts, event.subject, event.actor]),
      [['routine.started', '2026-11-10T09:00:00.250Z', first.routineId, 'scheduler']],
    )
    const finished = store.ofType('routine.finished').find((event) => event.data.routineId === first.routineId)
    assert.equal(finished?.data.durationMs, 0)
    assert.equal(finished?.data.actions, 1)
    assert.equal(finished?.data.actionsFailed, 0)
    assert.equal(first.inputsHash, 'hash-of-one')
  })

  it('records a run that did nothing as zero actions, not as an absence', async () => {
    const { deps, store } = harness()
    const pm = fakePm()
    pm.answers(NO_ACTIONS)
    const scheduler = createScheduler({ ...deps, pm })
    await scheduler.tick()
    const finished = store.ofType('routine.finished')
    assert.ok(finished.length > 0)
    assert.ok(finished.every((event) => event.data.actions === 0 && event.data.actionsFailed === 0))
  })

  it('records how many of the decided actions the executor could not carry out', async () => {
    const { deps, store, pm, executor } = harness()
    pm.answers(decided(3))
    executor.failNext(2)
    const scheduler = createScheduler(deps)
    const records = await scheduler.tick()
    const finished = headOf(store.ofType('routine.finished'), 'routine.finished')
    // A decision the PM made and the world refused is not a decision never made.
    assert.equal(finished.data.actions, 3)
    assert.equal(finished.data.actionsFailed, 2)
    assert.equal(headOf(records, 'record').actionsFailed, 2)
  })

  it('hands the decision to the executor, not to the store', async () => {
    const { deps, pm, executor } = harness()
    pm.answers(decided(2))
    const scheduler = createScheduler(deps)
    const records = await scheduler.tick()
    assert.ok(records.length > 0)
    assert.equal(executor.requests.length, records.length, 'one execution per routine that ran')
    assert.ok(executor.requests.every((request) => request.actions.length === 2))
    assert.deepEqual([...new Set(executor.requests.map((request) => request.routineId))].sort(), [
      ...new Set(records.map((record) => record.routineId)),
    ].sort())
  })

  it('writes routine.failed with the error when a body throws', async () => {
    const { deps, store } = harness()
    const pm = fakePm()
    pm.failNext(new Error('the store is on fire'))
    const scheduler = createScheduler({ ...deps, pm })
    const records = await scheduler.tick()
    const failed = store.ofType('routine.failed')
    assert.equal(failed.length, 1)
    assert.match(headOf(failed, 'routine.failed').data.error, /on fire/)
    assert.equal(headOf(records, 'record').ok, false)
  })

  it('a run whose body threw is due at its own period, not on the next tick', async () => {
    const { deps, store, pm } = harness()
    pm.failNext(new Error('the forge is down'))
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    assert.equal(store.ofType('routine.failed').length, 1)
    const ran = store.ofType('routine.started').length

    // The clock has not moved, so nothing is due again — the routine whose body
    // threw included. A failed run is a run: `branch-cleanup` reaching the forge
    // every tick for as long as `gh` was failing is the bug this holds shut.
    await scheduler.tick()
    assert.equal(store.ofType('routine.started').length, ran)
    assert.equal(store.ofType('routine.failed').length, 1, 'and it did not fail a second time')
  })

  it('does not run a body whose start cannot be recorded', async () => {
    const { deps, store, pm, executor } = harness()
    store.failNext(10)
    const scheduler = createScheduler(deps)
    const records = await scheduler.tick()
    assert.ok(records.every((record) => record.ok === false))
    assert.equal(pm.requests.length, 0)
    assert.equal(executor.requests.length, 0)
  })
})

describe('a failing routine backs off, and says so once it is broken', () => {
  /** Every routine but `dispatch` off, so a run in this block is the one the test is about. */
  const dispatchOnly = {
    'keep-busy': { enabled: false },
    'pr-babysit': { enabled: false },
    standup: { enabled: false },
    'worktree-gc': { enabled: false },
    'branch-cleanup': { enabled: false },
    reconcile: { enabled: false },
    'security-scan': { enabled: false },
    notify: { enabled: false },
    'tracker-sync': { enabled: false },
  }

  /** Every routine but `standup` off: the one routine with a daily period. */
  const standupOnly = { ...dispatchOnly, dispatch: { enabled: false }, standup: { enabled: true } }

  /** A body that fails with a settable error until it is told to succeed, and counts its runs. */
  const flaky = (kind: RoutineKind = 'dispatch') => {
    const state = { failing: true, error: 'remote said 500', runs: 0 }
    const factory: RoutineFactory = (): RoutineBody => ({
      kind,
      run: async () => {
        state.runs += 1
        if (state.failing) throw new Error(state.error)
        return outcome(1)
      },
    })
    return { state, factory }
  }

  const failingHarness = (overrides: Partial<SchedulerDeps> = {}) => {
    const { state, factory } = flaky()
    const built = harness({ config: dispatchOnly, factories: { dispatch: factory }, ...overrides })
    return { state, ...built }
  }

  /** The same, for the daily routine: the one whose period is a day. */
  const dailyHarness = () => {
    const { state, factory } = flaky('standup')
    const built = harness({ config: standupOnly, factories: { standup: factory } })
    return { state, ...built }
  }

  /** Tick a second at a time until the routine runs again, and answer how long it waited. */
  const waitForNextRun = async (
    state: { runs: number },
    tick: () => Promise<unknown>,
    clock: { advance: (ms: number) => void },
  ): Promise<number> => {
    const before = state.runs
    let waited = 0
    while (state.runs === before) {
      clock.advance(1_000)
      waited += 1_000
      await tick()
    }
    return waited
  }

  it('does not re-run a failed routine on the next tick', async () => {
    const { deps, state, clock } = failingHarness({ tickIntervalMs: 5_000 })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    assert.equal(state.runs, 1)
    // The old behaviour: `lastRun` never moved, so the very next tick was due
    // again and a broken routine hit its remote every 5 s forever (@132).
    clock.advance(5_000)
    await scheduler.tick()
    assert.equal(state.runs, 1, 'a failed routine must not be due on the next tick')
    // `dispatch` is a 60 s heartbeat, so its own period is the floor: the tick
    // interval doubling has to come out shorter than a minute for a while.
    clock.advance(5_000)
    await scheduler.tick()
    assert.equal(state.runs, 1, 'nor before the routine period has passed')
    clock.advance(50_000)
    await scheduler.tick()
    assert.equal(state.runs, 2, 'the first retry is at the routine period')
  })

  it('doubles past the routine period, and caps the wait at an hour', async () => {
    const { deps, state, clock } = failingHarness({ tickIntervalMs: 1_000 })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    const waits: number[] = []
    for (let failure = 0; failure < 14; failure += 1) {
      waits.push(await waitForNextRun(state, () => scheduler.tick(), clock))
    }
    // `max(period, min(tick · 2^failures, 1 h))`: `dispatch` runs every 60 s, so
    // the doubling only starts to bite once it is longer than a minute, and never
    // past the hour — a routine waiting longer than that has stopped running.
    const HOUR = 60 * 60 * 1_000
    const expected = waits.map((_, index) => Math.max(60_000, Math.min(1_000 * 2 ** (index + 1), HOUR)))
    assert.deepEqual(waits, expected)
    // The point of the block: the doubling does get past the period, rather than
    // being flattened to it.
    assert.ok(waits.at(-1) === HOUR, `the last wait should have reached the hour, got ${waits.at(-1)}`)
  })

  it('never retries a daily routine sooner than its day', async () => {
    const HOUR = 60 * 60 * 1_000
    const { deps, state, clock } = dailyHarness()
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    assert.equal(state.runs, 1)

    clock.advance(23 * HOUR)
    await scheduler.tick()
    assert.equal(state.runs, 1, 'the window has reopened, but not the day the backoff waits out')

    clock.advance(HOUR - 1)
    await scheduler.tick()
    assert.equal(state.runs, 1, 'a millisecond short of the day is still short of it')

    clock.advance(1)
    await scheduler.tick()
    assert.equal(state.runs, 2, 'and at the day it is retried, once')
  })

  it('runs on a later recurring trigger when the first one is not due', async () => {
    // `standup` is a daily schedule; an `everyMinutes` override appends a heartbeat after it, so the
    // routine's triggers are [schedule, heartbeat]. 03:17 never falls inside the minute these ticks cover.
    const { state, factory } = flaky('standup')
    state.failing = false
    const { deps, clock } = harness({
      config: { ...standupOnly, standup: { enabled: true, at: '03:17', everyMinutes: 1 } },
      factories: { standup: factory },
    })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    assert.equal(state.runs, 1, 'a routine that never ran is due')

    clock.advance(60_000)
    const records = await scheduler.tick()
    assert.equal(state.runs, 2, 'the heartbeat is due, though the schedule listed before it is not')
    assert.deepEqual(
      records.map((record) => record.trigger),
      ['heartbeat'],
      'and the run is labelled with the trigger that fired',
    )
  })

  it('escalates at the third failure, naming the error and the next retry', async () => {
    const { deps, store, state, clock } = failingHarness({ tickIntervalMs: 1_000 })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    assert.equal(store.ofType('routine.failing').length, 0, 'one failure is not a broken routine')
    await waitForNextRun(state, () => scheduler.tick(), clock)
    assert.equal(store.ofType('routine.failing').length, 0, 'nor two')
    await waitForNextRun(state, () => scheduler.tick(), clock)

    const escalation = headOf(store.ofType('routine.failing'), 'routine.failing')
    assert.equal(escalation.data.routineId, 'dispatch')
    assert.equal(escalation.data.failures, 3)
    assert.match(escalation.data.error, /remote said 500/)
    // The same backoff the tick will judge the retry against — `max(period, 1 s
    // doubled three times)`, and `dispatch`'s period is the minute that wins.
    assert.equal(escalation.data.retryAt, new Date(Date.parse(escalation.ts) + 60_000).toISOString())
  })

  it('does not ring again while the error is the same', async () => {
    const { deps, store, state, clock } = failingHarness({ tickIntervalMs: 1_000 })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await waitForNextRun(state, () => scheduler.tick(), clock)
    }
    assert.equal(state.runs, 6)
    assert.equal(store.ofType('routine.failing').length, 1, 'five failures, one banner')
  })

  it('rings again when the error changes, because the failure is a different one', async () => {
    const { deps, store, state, clock } = failingHarness({ tickIntervalMs: 1_000 })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await waitForNextRun(state, () => scheduler.tick(), clock)
    }
    state.error = 'now the token is expired'
    await waitForNextRun(state, () => scheduler.tick(), clock)

    const escalations = store.ofType('routine.failing')
    assert.equal(escalations.length, 2)
    assert.match(headOf(escalations.slice(1), 'second routine.failing').data.error, /token is expired/)
  })

  it('re-arms after a recovery, so a second run of failures rings again', async () => {
    const { deps, store, state, clock } = failingHarness({ tickIntervalMs: 1_000 })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await waitForNextRun(state, () => scheduler.tick(), clock)
    }
    assert.equal(store.ofType('routine.failing').length, 1)

    // It recovers: one healthy run, which is also what closes the banner.
    state.failing = false
    await waitForNextRun(state, () => scheduler.tick(), clock)
    assert.equal(store.ofType('routine.finished').length, 1)

    // And breaks again — a first failure again, so the third one is news.
    state.failing = true
    state.error = 'the remote is gone'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitForNextRun(state, () => scheduler.tick(), clock)
    }
    assert.equal(store.ofType('routine.failing').length, 2)
  })
})

describe('a miss is caught up on restart', () => {
  it('runs a heartbeat whose window closed while the daemon was down', async () => {
    const { deps, read, pm } = harness()
    const at = '2026-11-10T10:00:00.000Z'
    read.put({
      routines: [routineRow({ routineId: 'dispatch', kind: 'dispatch', lastRunAt: '2026-11-10T09:58:00.000Z' })],
    })
    const scheduler = createScheduler({ ...deps, clock: fixedClock(at) })
    await scheduler.start()
    assert.equal(decidedFor(pm).filter((kind) => kind === 'dispatch').length, 1)
  })

  it('does not run a heartbeat that is not yet due', async () => {
    const { deps, read, pm } = harness()
    const at = '2026-11-10T10:00:00.000Z'
    read.put({
      routines: [routineRow({ routineId: 'dispatch', kind: 'dispatch', lastRunAt: '2026-11-10T09:59:30.000Z' })],
    })
    const scheduler = createScheduler({ ...deps, clock: fixedClock(at) })
    await scheduler.start()
    assert.equal(decidedFor(pm).filter((kind) => kind === 'dispatch').length, 0)
  })

  it('catches a standup up once, not once per missed day', async () => {
    const { deps, read, pm } = harness({
      config: { 'worktree-gc': { enabled: false } },
    })
    const at = new Date(2026, 10, 10, 10, 0, 0, 0).toISOString()
    read.put({
      routines: [
        routineRow({ routineId: 'standup', kind: 'standup', lastRunAt: new Date(2026, 10, 3, 9, 0, 0, 0).toISOString() }),
      ],
    })
    const scheduler = createScheduler({ ...deps, clock: fixedClock(at) })
    const records = await scheduler.start()
    assert.equal(records.filter((record) => record.routineId === 'standup').length, 1)
    assert.equal(decidedFor(pm).filter((kind) => kind === 'standup').length, 1)
    // And a tick straight afterwards does not run it again.
    await scheduler.tick()
    assert.equal(decidedFor(pm).filter((kind) => kind === 'standup').length, 1)
  })

  it('treats a run left running by a dead daemon as failed, then runs it again', async () => {
    const { deps, read, store, pm } = harness()
    read.put({
      routines: [routineRow({ routineId: 'dispatch', kind: 'dispatch', state: 'running', lastRunAt: AT })],
    })
    const scheduler = createScheduler(deps)
    await scheduler.start()
    const failed = store.ofType('routine.failed')
    assert.equal(failed.length, 1)
    assert.match(headOf(failed, 'routine.failed').data.error, /interrupted/)
    assert.equal(decidedFor(pm).filter((kind) => kind === 'dispatch').length, 1)
  })

  it('runs startup-only routines at start and never on a tick', async () => {
    const { deps, pm } = harness()
    const scheduler = createScheduler(deps)
    await scheduler.start()
    assert.equal(decidedFor(pm).filter((kind) => kind === 'reconcile').length, 1)
    await scheduler.tick()
    // reconcile also has a 10 min heartbeat, which is not due a tick later.
    assert.equal(
      pm.requests.filter((request) => request.tick?.kind === 'reconcile' && request.tick.trigger === 'startup').length,
      1,
    )
  })
})

describe('overlap is prevented per routine', () => {
  it('skips a run while the previous one is still in flight', async () => {
    const runs: { routineId: string; trigger: string; at: string }[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: RoutineFactory = (): RoutineBody => ({
      kind: 'dispatch',
      run: async (context) => {
        runs.push({ routineId: context.routineId, trigger: context.trigger, at: context.at })
        await gate
        return outcome(1)
      },
    })
    const { deps, store } = harness({ factories: { dispatch: slow } })
    const scheduler = createScheduler(deps)

    const first = scheduler.tick()
    const second = scheduler.tick()
    release?.()
    const [firstRecords, secondRecords] = await Promise.all([first, second])

    assert.equal(runs.length, 1)
    assert.equal(store.ofType('routine.started').length, 1)
    assert.equal(store.ofType('routine.finished').length, 1)
    assert.equal(firstRecords.filter((record) => record.routineId === 'dispatch').length, 1)
    assert.equal(secondRecords.filter((record) => record.routineId === 'dispatch' && record.skipped).length, 1)
  })

  it('lets two different routines run at once', async () => {
    const runs: string[] = []
    const slow = (kind: RoutineKind): RoutineFactory => (): RoutineBody => ({
      kind,
      run: async () => {
        runs.push(kind)
        return outcome(1)
      },
    })
    const { deps } = harness({ factories: { dispatch: slow('dispatch'), reconcile: slow('reconcile') } })
    const scheduler = createScheduler(deps)
    const records = (await Promise.all([scheduler.tick(), scheduler.tick()])).flat()
    // Both kinds ran exactly once; a second tick may skip a routine that is
    // still going, but it never skips one on another routine's behalf.
    assert.deepEqual(runs.sort(), ['dispatch', 'reconcile'])
    assert.deepEqual(
      records.filter((record) => !record.skipped).map((record) => record.kind).sort(),
      ['dispatch', 'reconcile'],
    )
    assert.ok(
      records
        .filter((record) => record.skipped)
        .every((record) => record.kind === 'dispatch' || record.kind === 'reconcile'),
    )
  })
})

describe('the clock is the injected one', () => {
  it('measures a run with it, not with wall time', async () => {
    const clock = movableClock(AT)
    let released: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })
    const timed: RoutineFactory = (): RoutineBody => ({
      kind: 'dispatch',
      run: async () => {
        clock.advance(1_500)
        await gate
        return outcome(3)
      },
    })
    const { deps, store } = harness({ clock, factories: { dispatch: timed } })
    const scheduler = createScheduler(deps)
    const pending = scheduler.tick()
    released?.()
    await pending
    const finished = store.ofType('routine.finished').find((event) => event.data.kind === 'dispatch')
    assert.equal(finished?.data.durationMs, 1_500)
    assert.equal(finished?.data.actions, 3)
  })
})

describe('events wake the routines that listen', () => {
  it('runs keep-busy when a peer goes idle, recording the seq that woke it', async () => {
    const runs: { routineId: string; trigger: string; at: string }[] = []
    const { deps, store } = harness({ factories: { 'keep-busy': recordingFactory('keep-busy', runs) } })
    const scheduler = createScheduler(deps)
    const records = await scheduler.wake(peerStateChanged(41))
    assert.equal(runs.length, 1)
    assert.equal(headOf(runs, 'run').trigger, 'event')
    const started = headOf(store.ofType('routine.started'), 'routine.started')
    assert.equal(started.data.causedBySeq, 41)
    assert.equal(started.data.trigger, 'event')
    assert.equal(records.length, 1)
  })

  it('hands the waking event to the body, so `decide` sees the event and not just the state', async () => {
    const { deps, pm } = harness()
    const scheduler = createScheduler(deps)
    await scheduler.wake(peerStateChanged(41))
    assert.ok(pm.requests.length > 0)
    assert.ok(pm.requests.every((request) => request.event?.type === 'peer.state_changed'))
    assert.ok(pm.requests.every((request) => request.event?.seq === 41))
    assert.ok(pm.requests.every((request) => request.tick?.causedBySeq === 41))
  })

  it('leaves a routine alone for an event it does not listen for', async () => {
    const { deps, pm } = harness()
    const scheduler = createScheduler(deps)
    const records = await scheduler.wake(purgeStarted(7))
    assert.equal(records.length, 0)
    assert.equal(pm.requests.length, 0)
  })
})

describe('on request', () => {
  it('runs a routine the user names, and records it as a request', async () => {
    const runs: { routineId: string; trigger: string; at: string }[] = []
    const { deps } = harness({ factories: { standup: recordingFactory('standup', runs) } })
    const scheduler = createScheduler(deps)
    const record = await scheduler.request('standup')
    assert.equal(record.trigger, 'request')
    assert.deepEqual(runs, [{ routineId: 'standup', trigger: 'request', at: AT }])
  })

  it('refuses a routine that is not installed', async () => {
    const { deps } = harness()
    const scheduler = createScheduler(deps)
    await assert.rejects(() => scheduler.request('pr-babysit'), (thrown: { code?: string }) => {
      assert.equal(thrown.code, 'invalid_input')
      return true
    })
  })
})

describe('start and stop', () => {
  it('installs the timer at start and clears it at stop', async () => {
    const { deps, timers } = harness()
    const scheduler = createScheduler(deps)
    await scheduler.start()
    assert.equal(timers.installed.length, 1)
    assert.equal(headOf(timers.installed, 'timer').everyMs, 5_000)
    scheduler.stop()
    assert.equal(timers.cleared, 1)
  })

  it('takes the timer period from the daemon', async () => {
    const { deps, timers } = harness({ tickIntervalMs: 250 })
    const scheduler = createScheduler(deps)
    await scheduler.start()
    assert.equal(headOf(timers.installed, 'timer').everyMs, 250)
  })

  it('runs a tick when the timer fires', async () => {
    const runs: { routineId: string; trigger: string; at: string }[] = []
    const { deps, timers, clock } = harness({ factories: { dispatch: recordingFactory('dispatch', runs) } })
    const scheduler = createScheduler(deps)
    await scheduler.start()
    const before = runs.length
    clock.advance(61_000)
    await timers.fire()
    assert.ok(runs.length > before)
  })

  it('fails loudly if the projection cannot be read', async () => {
    const { deps } = harness()
    deps.read.routines.all = async () => {
      throw new Error('projection is unreadable')
    }
    const scheduler = createScheduler(deps)
    await assert.rejects(() => scheduler.start(), /unreadable/)
  })

  it('does not start twice', async () => {
    const { deps, pm } = harness()
    const scheduler = createScheduler(deps)
    await scheduler.start()
    const afterFirst = pm.requests.length
    await scheduler.start()
    assert.equal(pm.requests.length, afterFirst)
  })
})
