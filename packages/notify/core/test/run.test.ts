/**
 * The whole loop over the real store (§6.1): a decision is opened, the routine
 * sends one banner, stays quiet, sends its single reminder, and withdraws the
 * banner when the decision is answered. This is the test that would catch the
 * rules drifting from the projection — `remindedAt` and `withdrawnAt` are only
 * useful if the store and the planner agree on what they mean.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Clock, DecisionId, NotificationKey, Seq } from '@fleet/foundation-core'
import type { AppendEvent } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore } from '@fleet/foundation-store'
import type { Notifier, NotifierMessage } from '../src/notifier.ts'
import { runNotify } from '../src/run.ts'

const decisionId = 'dec_0123456789abcdef' as DecisionId
const key = `decision:${decisionId}` as NotificationKey

/** A clock the test moves forward, shared by the store and the routine, so both agree on when. */
const movingClock = (start: string) => {
  let millis = Date.parse(start)
  const clock: Clock = { now: () => new Date(millis).toISOString(), millis: () => millis }
  return {
    clock,
    advanceTo: (iso: string) => {
      millis = Date.parse(iso)
    },
  }
}

const fakeNotifier = () => {
  const sent: NotifierMessage[] = []
  const withdrawn: NotificationKey[] = []
  const notifier: Notifier = {
    id: 'fake',
    notify: async (message) => {
      sent.push(message)
      return { delivered: true }
    },
    withdraw: async (k) => {
      withdrawn.push(k)
    },
  }
  return { notifier, sent, withdrawn }
}

const open = async (clock: Clock): Promise<EventStore> =>
  openSqliteStore({ path: join(mkdtempSync(join(tmpdir(), 'fleet-notify-')), 'store.sqlite'), clock })

const requested: AppendEvent = {
  type: 'decision.requested',
  ts: '2026-11-10T09:00:00.000Z',
  subject: decisionId,
  actor: 'pm',
  data: {
    decisionId,
    kind: 'scope',
    question: 'Ship the notify packages before the security scanners?',
    options: ['notify', 'scanners'],
    inputsHash: 'sha256:0123456789abcdef',
  },
}

const answered: AppendEvent = {
  type: 'decision.answered',
  ts: '2026-11-10T20:00:00.000Z',
  subject: decisionId,
  actor: 'user',
  data: { decisionId, source: 'user', option: 'notify', durationMs: 0 },
}

describe('the notify routine, end to end (§6.1)', () => {
  it('notifies a decision once, reminds once after 8 h, and withdraws when it is answered', async () => {
    const time = movingClock('2026-11-10T09:00:00.000Z')
    const store = await open(time.clock)
    await store.append([requested])

    const fake = fakeNotifier()
    const run = async (at: string) => {
      time.advanceTo(at)
      return runNotify({ read: store.reader(), store, notifier: fake.notifier, clock: time.clock })
    }

    // 1. Opened, then one banner — the first time, not the fifth.
    const first = await run('2026-11-10T09:05:00.000Z')
    assert.deepEqual([first.sent, first.failed, first.withdrawn], [1, 0, 0])
    assert.equal(fake.sent.length, 1)
    assert.equal(fake.sent[0]?.action?.cmd, `fleet decide ${decisionId}`)
    let row = await store.reader().notifications.get(key)
    assert.equal(row?.state, 'sent')
    assert.equal(row?.sentAt, '2026-11-10T09:05:00.000Z')
    assert.equal(row?.channel, 'fake')

    // 2. Still open, still quiet: dedupe, and nothing was appended to say so.
    const head = await store.latestSeq()
    const again = await run('2026-11-10T09:10:00.000Z')
    assert.deepEqual([again.sent, again.failed, again.withdrawn], [0, 0, 0])
    assert.equal(await store.latestSeq(), head, 'a run with nothing to do appends nothing')

    // 3. Eight hours on, one quiet reminder — which the store records, because a second one is forbidden.
    const reminder = await run('2026-11-10T17:05:00.000Z')
    assert.equal(reminder.sent, 1)
    assert.equal(reminder.plan.send[0]?.reason, 'reminder')
    assert.match(fake.sent[1]?.title ?? '', /Still waiting/)
    row = await store.reader().notifications.get(key)
    assert.equal(row?.remindedAt, '2026-11-10T17:05:00.000Z')

    // 4. Never a second reminder, however long the decision sits.
    const later = await run('2026-11-10T19:00:00.000Z')
    assert.deepEqual([later.sent, later.withdrawn], [0, 0])
    assert.equal(fake.sent.length, 2)

    // 5. Answered: the banner comes down, and the row says it did — so a replay cannot withdraw twice.
    await store.append([answered])
    const closing = await run('2026-11-10T20:01:00.000Z')
    assert.deepEqual([closing.sent, closing.failed, closing.withdrawn], [0, 0, 1])
    assert.deepEqual(fake.withdrawn, [key])
    row = await store.reader().notifications.get(key)
    assert.equal(row?.state, 'resolved')
    assert.ok(row?.withdrawnAt !== undefined)

    const after = await run('2026-11-10T20:06:00.000Z')
    assert.deepEqual([after.sent, after.withdrawn, after.events.length], [0, 0, 0])

    await store.close()
  })

  it('a broken channel is notify.failed, and the next run tries again', async () => {
    const time = movingClock('2026-11-10T09:00:00.000Z')
    const store = await open(time.clock)
    await store.append([requested])

    let attempts = 0
    const broken: Notifier = {
      id: 'broken',
      notify: async () => {
        attempts += 1
        throw new Error('osascript is not available')
      },
    }

    const first = await runNotify({
      read: store.reader(),
      store,
      notifier: broken,
      clock: time.clock,
    })
    assert.deepEqual([first.sent, first.failed], [0, 1])

    const row = await store.reader().notifications.get(key)
    assert.equal(row?.state, 'pending', 'a failed delivery leaves the decision visible and pending (§6.1)')
    assert.equal(row?.deliveryFailed, true)

    // The channel comes back: a pending row is retried, and the banner goes out.
    const working = fakeNotifier()
    const second = await runNotify({ read: store.reader(), store, notifier: working.notifier, clock: time.clock })
    assert.equal(second.sent, 1)
    assert.equal(attempts, 1)
    assert.equal((await store.reader().notifications.get(key))?.deliveryFailed, false)

    await store.close()
  })

  it('the events a run appends are exactly notify.sent and notify.withdrawn', async () => {
    const time = movingClock('2026-11-10T09:00:00.000Z')
    const store = await open(time.clock)
    await store.append([requested])
    const before = await store.latestSeq()

    await runNotify({ read: store.reader(), store, notifier: fakeNotifier().notifier, clock: time.clock })
    const appended: Seq[] = []
    for (let seq = before + 1; seq <= (await store.latestSeq()); seq += 1) appended.push(seq)
    const events = await store.read(1)
    const mine = events.filter((event) => appended.includes(event.seq)).map((event) => event.type)

    assert.deepEqual(mine, ['notify.sent'])
    await store.close()
  })
})
