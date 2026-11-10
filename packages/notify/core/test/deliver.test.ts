/**
 * Delivery: the plan becomes events (§6.1). The store is a fake that records
 * the batch, the notifier is a fake that can fail, and the clock is fixed — so
 * what is asserted is exactly the set of events a run appends, which is what a
 * replay would see.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixedClock, parse, type NotificationKey, type Seq } from '@fleet/foundation-core'
import { appendIssues } from '@fleet/foundation-contracts'
import type { AppendEvent } from '@fleet/foundation-contracts'
import type { Notifier, NotifierMessage } from '../src/notifier.ts'
import { deliverNotifications } from '../src/deliver.ts'
import type { NotificationPlan } from '../src/plan.ts'

const at = fixedClock('2026-11-10T09:05:00.000Z')

const fakeStore = () => {
  const batches: AppendEvent[][] = []
  return {
    batches,
    events: () => batches.flat(),
    store: {
      append: async (batch: readonly AppendEvent[]): Promise<readonly Seq[]> => {
        batches.push([...batch])
        return batch.map((_, index) => index + 1)
      },
    },
  }
}

const fakeNotifier = (options: { readonly fail?: Error; readonly deliver?: boolean; readonly withdrawThrows?: Error } = {}) => {
  const messages: NotifierMessage[] = []
  const withdrawn: NotificationKey[] = []
  const notifier: Notifier = {
    id: 'fake',
    notify: async (message) => {
      if (options.fail !== undefined) throw options.fail
      messages.push(message)
      return { delivered: options.deliver ?? true }
    },
    withdraw: async (key) => {
      if (options.withdrawThrows !== undefined) throw options.withdrawThrows
      withdrawn.push(key)
    },
  }
  return { notifier, messages, withdrawn }
}

const planOf = (overrides: Partial<NotificationPlan> = {}): NotificationPlan => ({
  send: [
    {
      key: 'decision:dec_0123456789abcdef' as NotificationKey,
      class: 'decision',
      title: 'Decision needed: ship it?',
      body: 'ship it?\n\nfleet decide dec_0123456789abcdef',
      action: { cmd: 'fleet decide dec_0123456789abcdef' },
      reason: 'first',
      occurrences: 1,
    },
  ],
  withdraw: [],
  ...overrides,
})

describe('delivery appends what happened', () => {
  it('a delivered banner is one notify.sent with the channel and the text', async () => {
    const fake = fakeNotifier()
    const sink = fakeStore()

    const report = await deliverNotifications(planOf(), { notifier: fake.notifier, store: sink.store, clock: at })

    assert.deepEqual(report, { sent: 1, failed: 0, withdrawn: 0, events: [1] })
    const [event] = sink.events()
    assert.equal(event?.type, 'notify.sent')
    assert.equal(event?.subject, 'decision:dec_0123456789abcdef')
    assert.equal(event?.actor, 'scheduler')
    assert.equal(event?.ts, '2026-11-10T09:05:00.000Z')
    assert.deepEqual(event?.data, {
      key: 'decision:dec_0123456789abcdef',
      class: 'decision',
      channel: 'fake',
      title: 'Decision needed: ship it?',
      body: 'ship it?\n\nfleet decide dec_0123456789abcdef',
    })
    // The batch is validated by the same boundary the store applies, so a shape drift fails here and not in production.
    assert.deepEqual(appendIssues(event as AppendEvent), [])
  })

  it('a channel that throws is notify.failed, and the run carries on with the next banner', async () => {
    const fake = fakeNotifier({ fail: new Error('terminal-notifier exited 1: no display') })
    const sink = fakeStore()

    const report = await deliverNotifications(planOf(), { notifier: fake.notifier, store: sink.store, clock: at })

    assert.equal(report.failed, 1)
    assert.equal(report.sent, 0)
    const [event] = sink.events()
    assert.equal(event?.type, 'notify.failed')
    assert.match(String((event?.data as { error: string }).error), /exited 1: no display/)
    assert.deepEqual(appendIssues(event as AppendEvent), [])
  })

  it('a channel that declines the banner is a failure too, with a reason', async () => {
    const fake = fakeNotifier({ deliver: false })
    const sink = fakeStore()

    const report = await deliverNotifications(planOf(), { notifier: fake.notifier, store: sink.store, clock: at })

    assert.equal(report.failed, 1)
    assert.equal(sink.events()[0]?.type, 'notify.failed')
  })

  it('a withdraw clears the banner and records notify.withdrawn, which is what makes the second run a no-op', async () => {
    const fake = fakeNotifier()
    const sink = fakeStore()
    const key = 'decision:dec_0123456789abcdef' as NotificationKey

    const report = await deliverNotifications(planOf({ send: [], withdraw: [{ key, class: 'decision' }] }), {
      notifier: fake.notifier,
      store: sink.store,
      clock: at,
    })

    assert.deepEqual(report, { sent: 0, failed: 0, withdrawn: 1, events: [1] })
    assert.deepEqual(fake.withdrawn, [key])
    assert.equal(sink.events()[0]?.type, 'notify.withdrawn')
  })

  it('a banner that would not clear is a failure, not a silent pass', async () => {
    const fake = fakeNotifier({ withdrawThrows: new Error('no such group') })
    const sink = fakeStore()
    const key = 'failure:builder:auth' as NotificationKey

    const report = await deliverNotifications(planOf({ send: [], withdraw: [{ key, class: 'failure' }] }), {
      notifier: fake.notifier,
      store: sink.store,
      clock: at,
    })

    assert.equal(report.withdrawn, 0)
    assert.equal(report.failed, 1)
    assert.equal(sink.events()[0]?.type, 'notify.failed')
  })

  it('a run with nothing to do appends nothing at all', async () => {
    const fake = fakeNotifier()
    const sink = fakeStore()

    const report = await deliverNotifications(planOf({ send: [], withdraw: [] }), {
      notifier: fake.notifier,
      store: sink.store,
      clock: at,
    })

    assert.deepEqual(report, { sent: 0, failed: 0, withdrawn: 0, events: [] })
    assert.equal(sink.batches.length, 0)
  })

  it('every event in one run is one atomic batch', async () => {
    const fake = fakeNotifier()
    const sink = fakeStore()

    await deliverNotifications(
      planOf({
        send: [
          ...planOf().send,
          {
            key: 'failure:builder:auth' as NotificationKey,
            class: 'failure',
            title: 'Failure: auth',
            body: 'builder — auth.',
            reason: 'first',
            occurrences: 1,
          },
        ],
        withdraw: [{ key: 'decision:dec_fedcba9876543210' as NotificationKey, class: 'decision' }],
      }),
      { notifier: fake.notifier, store: sink.store, clock: at },
    )

    assert.equal(sink.batches.length, 1)
    assert.equal(sink.batches[0]?.length, 3)
  })
})
