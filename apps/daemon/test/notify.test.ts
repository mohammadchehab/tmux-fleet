/**
 * The daemon's side of §6.1: the `notify` routine as the scheduler sees it.
 *
 * `@fleet/notify-core`'s own tests prove the rules and the channel; the thing
 * that can still be wrong here is the marriage — a factory registered under the
 * wrong kind, an outcome that reports work it did not do, or a standup whose
 * text never reaches the banner because the daemon read the projection instead
 * of the event. So this test drives the body through `RoutineContext`, exactly
 * as the scheduler does, over the real store.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Clock, DecisionId, NotificationKey } from '@fleet/foundation-core'
import type { AppendEvent, FleetEvent } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore } from '@fleet/foundation-store'
import type { Notifier, NotifierMessage } from '@fleet/notify-core'
import type { RoutineContext } from '@fleet/orchestration-routines'
import { createNotifyFactory, notifierFor } from '../src/notify.ts'

const decisionId = 'dec_0123456789abcdef' as DecisionId
const key = `decision:${decisionId}` as NotificationKey

const clockAt = (iso: string): Clock => ({
  now: () => iso,
  millis: () => Date.parse(iso),
})

const fakeNotifier = () => {
  const sent: NotifierMessage[] = []
  const notifier: Notifier = {
    id: 'fake',
    notify: async (message) => {
      sent.push(message)
      return { delivered: true }
    },
    withdraw: async () => {},
  }
  return { notifier, sent }
}

const open = async (clock: Clock): Promise<EventStore> =>
  openSqliteStore({ path: join(mkdtempSync(join(tmpdir(), 'fleet-daemon-notify-')), 'store.sqlite'), clock })

const requested: AppendEvent = {
  type: 'decision.requested',
  ts: '2026-11-10T09:00:00.000Z',
  subject: decisionId,
  actor: 'pm',
  data: {
    decisionId,
    kind: 'scope',
    question: 'Ship the notify routine before the security scanners?',
    options: ['notify', 'scanners'],
    inputsHash: 'sha256:0123456789abcdef',
  },
}

const standupRendered: AppendEvent = {
  type: 'standup.rendered',
  ts: '2026-11-10T09:00:00.000Z',
  subject: '2026-11-10',
  actor: 'scheduler',
  data: {
    date: '2026-11-10',
    text: '## 2026-11-10\n- engineer-1: shipped the notify routine\n',
    peers: 3,
    openDecisions: 1,
  },
}

const context = (at: string, event?: FleetEvent): RoutineContext => ({
  routineId: 'notify',
  kind: 'notify',
  trigger: event === undefined ? 'heartbeat' : 'event',
  at,
  clock: { now: () => at, millis: () => Date.parse(at) },
  ...(event === undefined ? {} : { event }),
})

describe('the notify routine the daemon registers (§6.1)', () => {
  it('is one tick of the daemon body: it delivers, appends, and reports what it did', async () => {
    const store = await open(clockAt('2026-11-10T09:05:00.000Z'))
    await store.append([requested])

    const fake = fakeNotifier()
    const calls = { read: 0 }
    const factory = createNotifyFactory({ store: { append: (batch) => store.append(batch) }, notifier: fake.notifier })
    const body = factory({
      // The PM and the executor are offered to every body; a notification uses
      // neither, and these throw the moment that stops being true.
      pm: { decide: () => assert.fail('a notification tick never decides') } as never,
      executor: { execute: async () => assert.fail('a notification tick never executes') } as never,
      read: new Proxy(store.reader(), {
        get: (target, property, receiver) => {
          calls.read += 1
          return Reflect.get(target, property, receiver)
        },
      }),
    })

    assert.equal(body.kind, 'notify')
    const outcome = await body.run(context('2026-11-10T09:05:00.000Z'))

    assert.equal(outcome.actions, 1, 'one banner went out')
    assert.equal(outcome.actionsFailed, 0)
    assert.match(outcome.inputsHash, /^[0-9a-f]{16}$/, 'the plan it acted on is hashed, so a run is replayable (§5.4)')
    assert.ok(calls.read > 0, 'the body reads the projections the scheduler handed it, not ones of its own')

    assert.equal(fake.sent.length, 1)
    assert.equal(fake.sent[0]?.action?.cmd, `fleet decide ${decisionId}`)
    assert.equal((await store.reader().notifications.get(key))?.state, 'sent')

    await store.close()
  })

  it('reports a delivery it could not perform as an action that failed', async () => {
    const store = await open(clockAt('2026-11-10T09:05:00.000Z'))
    await store.append([requested])

    const broken: Notifier = {
      id: 'broken',
      notify: async () => {
        throw new Error('osascript is not available')
      },
    }
    const body = createNotifyFactory({ store: { append: (batch) => store.append(batch) }, notifier: broken })({
      pm: {} as never,
      executor: {} as never,
      read: store.reader(),
    })

    const outcome = await body.run(context('2026-11-10T09:05:00.000Z'))
    assert.deepEqual([outcome.actions, outcome.actionsFailed], [1, 1], 'attempted once, and the run says it failed')

    await store.close()
  })

  it('a `standup.rendered` wake carries the standup text into the banner', async () => {
    const store = await open(clockAt('2026-11-10T09:05:00.000Z'))
    await store.append([standupRendered])
    const [event] = await store.read(1)
    assert.equal(event?.type, 'standup.rendered')

    const fake = fakeNotifier()
    const body = createNotifyFactory({ store: { append: (batch) => store.append(batch) }, notifier: fake.notifier })({
      pm: {} as never,
      executor: {} as never,
      read: store.reader(),
    })
    const outcome = await body.run(context('2026-11-10T09:05:00.000Z', event))

    assert.equal(outcome.actions, 1)
    assert.match(fake.sent[0]?.body ?? '', /shipped the notify routine/, 'the text comes from the event, not the row')

    await store.close()
  })

  it('a heartbeat with nothing new is a legitimate zero, and appends nothing', async () => {
    const store = await open(clockAt('2026-11-10T09:05:00.000Z'))
    await store.append([requested])
    const sink = { append: (batch: readonly AppendEvent[]) => store.append(batch) }
    const body = createNotifyFactory({ store: sink, notifier: fakeNotifier().notifier })({
      pm: {} as never,
      executor: {} as never,
      read: store.reader(),
    })
    await body.run(context('2026-11-10T09:05:00.000Z'))
    const head = await store.latestSeq()

    const quiet = await body.run(context('2026-11-10T09:06:00.000Z'))
    assert.deepEqual([quiet.actions, quiet.actionsFailed], [0, 0])
    assert.equal(await store.latestSeq(), head)

    await store.close()
  })
})

describe('the channel a profile names (§6.1)', () => {
  it('is off when the profile says none, or says nothing at all', () => {
    const log = () => assert.fail('nothing to warn about')
    assert.equal(notifierFor({ notify: { channel: 'none' } } as never, 'darwin', log), undefined)
    assert.equal(notifierFor({} as never, 'darwin', log), undefined)
  })

  it('is the macOS channel on a Mac', () => {
    const notifier = notifierFor({ notify: { channel: 'macos' } } as never, 'darwin', () => assert.fail('no warning'))
    assert.equal(notifier?.id, 'macos')
  })

  it('refuses to pretend on a host that is not a Mac, and says so once', () => {
    const lines: string[] = []
    const notifier = notifierFor({ notify: { channel: 'macos' } } as never, 'linux', (line) => lines.push(line))
    assert.equal(notifier, undefined)
    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /macos.*linux/)
  })
})
