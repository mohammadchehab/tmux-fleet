/**
 * The turn boundary a hold waits for, and the resumed start a release records
 * (watch-and-attach §4).
 *
 * Its own rig, on purpose: `session.test.ts`'s rig ends a session with `exit`,
 * which TASK-39 turned into a recovery onto a feed nothing ends. This one only
 * ever ends a session by stopping it, which is how a hold ends one.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fixedClock, type PeerId, type QuestionId, type TurnId } from '@fleet/foundation-core'
import type { ProviderEvent } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle } from '@fleet/runtime-provider-sdk'

import { PeerSession, type SessionRecord } from '../src/index.ts'

const peerId = 'engineer-1' as PeerId
const opening = 'trn_00000000000000aa' as TurnId
const later = 'trn_00000000000000bb' as TurnId
const at = '2026-11-11T09:00:00.000Z'

const handle: SessionHandle = {
  sessionId: 'ses_aaaaaaaaaaaaaaaa',
  sessionRef: 'chat-1' as SessionHandle['sessionRef'],
  peerId,
  providerId: 'claude',
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  briefTurnId: opening,
}

/** A provider whose stream the test writes, and whose stop ends it the way every adapter does. */
const rig = () => {
  const queue: ProviderEvent[] = []
  let wake: (() => void) | undefined
  let closed = false
  const calls: string[] = []
  const push = (...events: ProviderEvent[]): void => {
    queue.push(...events)
    wake?.()
  }
  const stream: AsyncIterable<ProviderEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        for (;;) {
          const event = queue.shift()
          if (event !== undefined) return { value: event, done: false }
          if (closed) return { value: undefined, done: true }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      },
    }),
  }
  const provider = {
    id: 'claude',
    capabilities: { resume: true, modelSwitch: true, usageTokens: true, usageCost: true, structuredOutput: true, permissionModes: ['default'] },
    events: () => stream,
    status: async () => 'idle',
    usage: async () => ({ contextTokens: 10, contextLimit: 1_000 }),
    interrupt: async () => {
      calls.push('interrupt')
    },
    stop: async () => {
      calls.push('stop')
      push({ type: 'session.ended', reason: 'stopped' })
      closed = true
      wake?.()
    },
  } as unknown as Provider
  const records: SessionRecord[] = []
  const session = (resumed?: boolean) =>
    new PeerSession({
      provider,
      handle,
      peerId,
      briefVersion: 1,
      limits: { contextRatio: 0.8, autoCompactRatio: 0.9, maxTurns: 100, maxSessionMillis: 3_600_000 },
      clock: fixedClock(at),
      record: (record) => {
        records.push(record)
      },
      purge: async () => {
        throw new Error('must not purge')
      },
      recover: async () => {
        throw new Error('must not recover')
      },
      ...(resumed === undefined ? {} : { resumed }),
    })
  return { push, provider, calls, records, session }
}

/** Whether a promise has settled after the loop has had a few turns to run. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false
  void promise.then(() => {
    done = true
  })
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
  return done
}

test('a hold during the opening turn waits for it, though the provider already says idle (§4)', async () => {
  const r = rig()
  const session = r.session()
  const run = session.run()
  r.push({ type: 'turn.started', turnId: opening, at })

  const boundary = session.untilBoundary()
  assert.equal(await settled(boundary), false, 'the brief is still in flight')
  r.push({ type: 'turn.ended', turnId: opening, at, reason: 'completed' })
  assert.equal(await settled(boundary), true, 'the opening turn ended: that is the boundary')

  await session.stop()
  await run
})

test('a question asked during the opening turn ends that turn for the boundary, its turn.ended or not (TASK-120)', async () => {
  const r = rig()
  const session = r.session()
  const run = session.run()
  r.push({ type: 'turn.started', turnId: opening, at })
  const questionId = 'qst_0000000000000002' as QuestionId
  r.push({ type: 'question.asked', turnId: opening, questionId, questions: [] } as unknown as ProviderEvent)

  const boundary = session.untilBoundary()
  assert.equal(await settled(boundary), false, 'the person still owes an answer, so there is no boundary yet')
  // The person answers, and the SDK carries on without ever sending `turn.ended`
  // for the opening turn. Waiting for one that will not come held a hold forever.
  r.push({ type: 'question.abandoned', questionId })
  assert.equal(await settled(boundary), true, 'the question is settled and the opening turn is over')

  await session.stop()
  await run
})

test('a hold waits for a running turn and for a question a person still owes', async () => {
  const r = rig()
  const session = r.session()
  const run = session.run()
  r.push({ type: 'turn.started', turnId: opening, at }, { type: 'turn.ended', turnId: opening, at, reason: 'completed' })
  assert.equal(await settled(session.untilBoundary()), true, 'idle after the brief')

  r.push({ type: 'turn.started', turnId: later, at })
  await settled(Promise.resolve())
  const boundary = session.untilBoundary()
  r.push({ type: 'question.asked', turnId: later, questionId: 'qst_0000000000000001' as QuestionId, questions: [] } as unknown as ProviderEvent)
  assert.equal(await settled(boundary), false, 'a turn is running')
  r.push({ type: 'question.abandoned', questionId: 'qst_0000000000000001' as QuestionId })
  assert.equal(await settled(boundary), false, 'the turn has not ended')
  r.push({ type: 'turn.ended', turnId: later, at, reason: 'completed' })
  assert.equal(await settled(boundary), true)

  await session.stop()
  await run
})

test('a hold with now interrupts the turn, and the interrupted turn is the boundary', async () => {
  const r = rig()
  const session = r.session()
  const run = session.run()
  r.push({ type: 'turn.started', turnId: opening, at }, { type: 'turn.ended', turnId: opening, at, reason: 'completed' })
  r.push({ type: 'turn.started', turnId: later, at })
  await settled(Promise.resolve())
  const boundary = session.untilBoundary()
  assert.equal(await settled(boundary), false)
  await session.interrupt()
  assert.deepEqual(r.calls, ['interrupt'])
  r.push({ type: 'turn.ended', turnId: later, at, reason: 'interrupted' })
  assert.equal(await settled(boundary), true)
  await session.stop()
  await run
  assert.equal(session.state, 'ended', 'a stopped session is ended, not failed, and not recovered')
})

test('a session that ends releases every wait for a boundary', async () => {
  const r = rig()
  const session = r.session()
  const run = session.run()
  r.push({ type: 'turn.started', turnId: opening, at })
  const boundary = session.untilBoundary()
  await session.stop()
  await run
  assert.equal(await settled(boundary), true)
})

test('a resumed session records its start as resumed, once (§4)', async () => {
  const r = rig()
  const session = r.session(true)
  const run = session.run()
  await session.stop()
  await run
  const starts = r.records.filter((record) => record.type === 'session.started')
  assert.equal(starts.length, 1)
  assert.equal(starts[0]?.type === 'session.started' ? starts[0].data.resumed : undefined, true)
})

test('a session started fresh still records resumed: false', async () => {
  const r = rig()
  const session = r.session()
  const run = session.run()
  await session.stop()
  await run
  const start = r.records.find((record) => record.type === 'session.started')
  assert.equal(start?.type === 'session.started' ? start.data.resumed : undefined, false)
})
