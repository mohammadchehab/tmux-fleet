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
  it('installs the four phase 1 bodies and reports the four still waiting for one', () => {
    const { deps } = harness()
    const scheduler = createScheduler(deps)
    assert.deepEqual([...scheduler.plan.installed].sort(), ['dispatch', 'keep-busy', 'reconcile', 'standup'])
    assert.deepEqual(
      [...scheduler.plan.unimplemented].sort(),
      ['notify', 'pr-babysit', 'security-scan', 'worktree-gc'],
    )
  })

  it('does not run a routine the profile disabled', async () => {
    const { deps, pm, store } = harness({ config: { routines: { standup: { enabled: false } } } })
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
    const first = records[0]
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
    const finished = store.ofType('routine.finished')[0]
    // A decision the PM made and the world refused is not a decision never made.
    assert.equal(finished.data.actions, 3)
    assert.equal(finished.data.actionsFailed, 2)
    assert.equal(records[0].actionsFailed, 2)
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
    assert.match(failed[0].data.error, /on fire/)
    assert.equal(records[0].ok, false)
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
      config: { routines: { 'worktree-gc': { enabled: false } } },
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
    assert.match(failed[0].data.error, /interrupted/)
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
    assert.equal(runs[0].trigger, 'event')
    const started = store.ofType('routine.started')[0]
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
    assert.equal(timers.installed[0].everyMs, 5_000)
    scheduler.stop()
    assert.equal(timers.cleared, 1)
  })

  it('takes the timer period from the daemon', async () => {
    const { deps, timers } = harness({ tickIntervalMs: 250 })
    const scheduler = createScheduler(deps)
    await scheduler.start()
    assert.equal(timers.installed[0].everyMs, 250)
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
