/**
 * §6.1 through the real daemon: a profile that names a channel gets banners,
 * and the routine that rings is the one `compose()` registered.
 *
 * The unit tests prove the rules and the factory; what only this can prove is
 * the wiring — that the profile's `notify.channel` reaches the scheduler's
 * factory map, that the body runs on the trigger the scheduler already had
 * configured, and that what it appends lands in the store the daemon is using.
 * The channel itself is injected so a test run never puts a banner on a screen.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AppendEvent } from '../../../packages/foundation/contracts/src/index.ts'
import type { DecisionId } from '../../../packages/foundation/core/src/index.ts'
import type { Notifier, NotifierMessage } from '../../../packages/notify/core/src/index.ts'
import { createSandbox, until } from '../support/sandbox.ts'

const decisionId = 'dec_0123456789abcdef' as DecisionId

const requested: AppendEvent = {
  type: 'decision.requested',
  ts: '2026-11-10T09:00:00.000Z',
  subject: decisionId,
  actor: 'pm',
  data: {
    decisionId,
    kind: 'scope',
    question: 'Ship the notify routine as one PR in the daemon?',
    options: ['one PR', 'split'],
    inputsHash: 'sha256:0123456789abcdef',
  },
}

const recordingNotifier = () => {
  const sent: NotifierMessage[] = []
  const notifier: Notifier = {
    id: 'recording',
    notify: async (message) => {
      sent.push(message)
      return { delivered: true }
    },
    withdraw: async () => {},
  }
  return { notifier, sent }
}

test('§6.1: a decision opened in a real fleet reaches the channel the profile named', async (t) => {
  const recording = recordingNotifier()
  const sandbox = await createSandbox({ notify: 'macos', notifier: recording.notifier })
  t.after(() => sandbox.stop())

  await sandbox.call('up')

  // The PM would append this itself; the rule under test is what the fleet does
  // with the event, so the test writes the event the PM writes. It is handed to
  // the scheduler the way §6 says a routine is woken — the daemon has no hook
  // from an append to `wake()` yet, which is reported as a finding rather than
  // worked around in the production path.
  await sandbox.composed.store.append([requested])
  const event = (await sandbox.composed.store.read(0, 10_000)).find((e) => e.type === 'decision.requested')
  assert.ok(event !== undefined)
  await sandbox.composed.scheduler.wake(event)

  const banner = await until(() => recording.sent[0], 'the decision to reach the channel')
  assert.equal(banner.key, `decision:${decisionId}`)
  assert.equal(banner.action?.cmd, `fleet decide ${decisionId}`)

  // And the run is in the record the daemon serves, not only in the channel: a
  // banner nobody can trace back to a routine run is the silence §6 forbids.
  interface RoutinesLike {
    readonly routines: readonly { readonly kind: string; readonly runs: number }[]
  }
  const ls = await sandbox.call<RoutinesLike>('ls')
  const notify = ls.routines.find((routine) => routine.kind === 'notify')
  assert.ok(notify !== undefined, 'the notify routine ran at least once')
  assert.ok(notify.runs >= 1)

  const sent = (await sandbox.events()).filter((event) => event.type === 'notify.sent')
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.data.class, 'decision')
})
