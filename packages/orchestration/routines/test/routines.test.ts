/**
 * The four phase 1 bodies (§6). Each one is a seam, not a rule: the rule is the
 * PM's (§5.2), so the test is that the routine loads a snapshot, asks the PM
 * with the right request, hands the answer to the executor, and reports both
 * counts — not that it re-implements `assign`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse, systemClock } from '@fleet/foundation-core'
import type { RoutineTrigger } from '@fleet/foundation-contracts'
import { peer as peerSchema } from '@fleet/foundation-contracts'
import type { RoutineContext } from '../src/routine.ts'
import { dispatch, keepBusy, reconcile, standup } from '../src/routines/index.ts'
import {
  AT,
  NO_ACTIONS,
  decided,
  fakeExecutor,
  fakePm,
  fakeRead,
  peerStateChanged,
  renderStandup,
  type FakeExecutor,
  type FakePm,
  type FakeRead,
} from './support/fakes.ts'

const contextOf = (overrides: Partial<RoutineContext> = {}): RoutineContext => ({
  routineId: 'dispatch',
  kind: 'dispatch',
  trigger: 'heartbeat',
  at: AT,
  clock: systemClock,
  ...overrides,
})

/** The three ports a body is given, kept as their fakes so a test can inspect and steer them. */
interface FakeDeps {
  readonly pm: FakePm
  readonly executor: FakeExecutor
  readonly read: FakeRead
}

const depsOf = (overrides: Partial<FakeDeps> = {}): FakeDeps => ({
  pm: fakePm(),
  executor: fakeExecutor(),
  read: fakeRead(),
  ...overrides,
})

describe('a routine is a seam onto the PM', () => {
  const cases: { readonly name: string; readonly factory: typeof dispatch; readonly kind: RoutineContext['kind'] }[] = [
    { name: 'dispatch', factory: dispatch, kind: 'dispatch' },
    { name: 'keep-busy', factory: keepBusy, kind: 'keep-busy' },
    { name: 'standup', factory: standup, kind: 'standup' },
    { name: 'reconcile', factory: reconcile, kind: 'reconcile' },
  ]

  for (const entry of cases) {
    it(`${entry.name} asks the PM for one tick, and reports its actions`, async () => {
      const deps = depsOf()
      deps.pm.answers(decided(4))
      const body = entry.factory(deps)
      assert.equal(body.kind, entry.kind)

      const outcome = await body.run(
        contextOf({ routineId: entry.name, kind: entry.kind, trigger: 'startup' as RoutineTrigger }),
      )

      assert.deepEqual(outcome, { actions: 4, actionsFailed: 0, inputsHash: 'hash-of-one' })
      assert.equal(deps.pm.requests.length, 1)
      assert.deepEqual(deps.pm.requests[0].tick, {
        routineId: entry.name,
        kind: entry.kind,
        trigger: 'startup',
        at: AT,
      })
      assert.equal(deps.executor.requests.length, 1)
      assert.equal(deps.executor.requests[0].routineId, entry.name)
      assert.equal(deps.executor.requests[0].actions.length, 4)
    })
  }

  it('loads the state before deciding: the PM sees the projections, not the store', async () => {
    const peer = parse(peerSchema(), {
      peerId: 'engineer-1',
      role: 'engineer',
      providerId: 'claude-code',
      model: 'opus',
      permissionMode: 'default',
      briefVersion: 0,
      state: 'idle',
      registeredAt: AT,
      updatedAt: AT,
    })
    const read = fakeRead({ peers: [peer] })
    const deps = depsOf({ read })
    await dispatch(deps).run(contextOf())
    assert.deepEqual(deps.pm.requests[0].state.peers, [peer])
    // Every projection is in the snapshot, empty or not (§5.2's `ReadModel`).
    assert.deepEqual(Object.keys(deps.pm.requests[0].state).sort(), [
      'decisions',
      'findings',
      'messages',
      'notifications',
      'peers',
      'pullRequests',
      'routines',
      'sessions',
      'work',
      'worktrees',
    ])
  })

  it('passes the event that woke it, so the tick can be audited back to it', async () => {
    const deps = depsOf()
    const event = peerStateChanged(88)
    await keepBusy(deps).run(contextOf({ kind: 'keep-busy', trigger: 'event', event }))
    assert.equal(deps.pm.requests[0].event, event)
    assert.equal(deps.pm.requests[0].tick?.causedBySeq, 88)
    assert.equal(deps.executor.requests[0].causedBySeq, 88)
  })

  it('leaves causedBySeq absent on a heartbeat rather than sending undefined', async () => {
    const deps = depsOf()
    await dispatch(deps).run(contextOf())
    assert.equal('causedBySeq' in (deps.pm.requests[0].tick ?? {}), false)
    assert.equal('causedBySeq' in deps.executor.requests[0], false)
  })

  it('reports what the executor could not carry out, not just what the PM chose', async () => {
    const deps = depsOf()
    deps.pm.answers(decided(3))
    deps.executor.failNext(1)
    const outcome = await dispatch(deps).run(contextOf())
    assert.deepEqual(outcome, { actions: 3, actionsFailed: 1, inputsHash: 'hash-of-one' })
  })

  it('renders standup as an action, so the renderer is the executor’s and not the body’s', async () => {
    const deps = depsOf()
    deps.pm.answers({ actions: [renderStandup('2026-11-10')], inputsHash: 'hash-of-standup' })
    const outcome = await standup(deps).run(contextOf({ routineId: 'standup', kind: 'standup' }))
    assert.deepEqual(outcome, { actions: 1, actionsFailed: 0, inputsHash: 'hash-of-standup' })
    assert.equal(deps.executor.requests[0].actions[0].kind, 'render_standup')
  })

  it('propagates a PM failure, which the scheduler records as routine.failed', async () => {
    const deps = depsOf()
    deps.pm.failNext(new Error('pm cannot tick'))
    await assert.rejects(() => dispatch(deps).run(contextOf()), /pm cannot tick/)
    assert.equal(deps.executor.requests.length, 0, 'a decision that threw is not executed')
  })

  it('does not execute when the PM decided nothing', async () => {
    const deps = depsOf()
    deps.pm.answers(NO_ACTIONS)
    const outcome = await dispatch(deps).run(contextOf())
    assert.deepEqual(outcome, { actions: 0, actionsFailed: 0, inputsHash: 'hash-of-nothing' })
    assert.deepEqual(deps.executor.requests[0].actions, [])
  })

  it('is constructed with the PM, the executor and the read model, and nothing else', () => {
    // A body that could append events or start sessions would be a second place
    // work is decided (§2, §5.2). It gets a decision, a way to perform it, and
    // a way to look; the events are the executor's.
    const body = dispatch(depsOf())
    assert.deepEqual(Object.keys(body).sort(), ['kind', 'run'])
  })
})
