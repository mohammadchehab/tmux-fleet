/**
 * The pending map is what makes `waiting_input` a fact rather than an
 * inference (§4): a question or an approval that is open blocks the turn, and
 * one that is abandoned must unblock it — leaving a promise unsettled parks the
 * session forever, which is the one failure the spike found the SDK will not
 * recover from on its own.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TurnId } from '@fleet/foundation-core'

import { PendingRequests } from '../src/index.ts'

const turnA = 'trn_aaaaaaaaaaaaaaaa' as TurnId
const turnB = 'trn_bbbbbbbbbbbbbbbb' as TurnId
const now = (): string => '2026-08-20T10:00:00.000Z'

test('a question blocks until it is answered by id', async () => {
  const pending = new PendingRequests(now)
  const { open, wait } = pending.ask(turnA, [{ question: 'Which channel?' }])
  assert.equal(pending.blocked, true)
  assert.match(open.questionId, /^qst_[0-9a-f]{16}$/)

  pending.answer('Blue', open.questionId)
  assert.equal(await wait, 'Blue')
  assert.equal(pending.blocked, false)
})

test('without an id the oldest open question is answered, which is all a flat event allows', async () => {
  const pending = new PendingRequests(now)
  const first = pending.ask(turnA, [{ question: 'First?' }])
  const second = pending.ask(turnB, [{ question: 'Second?' }])

  pending.answer('to the first')
  assert.equal(await first.wait, 'to the first')
  assert.equal(pending.snapshot().questions[0]?.questionId, second.open.questionId)
})

test('an approval resolves to allow or deny and reports which', async () => {
  const pending = new PendingRequests(now)
  const allowed = pending.askApproval(turnA, 'Bash', 'rm -rf build')
  const denied = pending.askApproval(turnA, 'Write', '/etc/hosts')
  assert.match(allowed.open.requestId, /^apr_[0-9a-f]{16}$/)

  pending.respond('allow', allowed.open.requestId)
  pending.respond('deny', denied.open.requestId)
  assert.equal(await allowed.wait, 'allow')
  assert.equal(await denied.wait, 'deny')
  assert.equal(pending.blocked, false)
})

test('abandoning one turn leaves the other turn’s questions alone', async () => {
  const pending = new PendingRequests(now)
  const a = pending.ask(turnA, [{ question: 'A?' }])
  const b = pending.ask(turnB, [{ question: 'B?' }])

  const abandoned = pending.abandon('interrupted', turnA)
  assert.deepEqual(
    abandoned.questions.map((q) => q.questionId),
    [a.open.questionId],
  )
  assert.equal(await a.wait, '')
  assert.equal(pending.snapshot().questions.length, 1)
  assert.equal(pending.snapshot().questions[0]?.questionId, b.open.questionId)
})

test('abandoning an approval resolves it as deny: no tool runs unanswered', async () => {
  const pending = new PendingRequests(now)
  const approval = pending.askApproval(turnA, 'Bash', undefined)
  pending.abandon('ended')
  assert.equal(await approval.wait, 'deny')
  assert.equal(pending.blocked, false)
})

test('answering something that is not open is not_found, not a crash', () => {
  const pending = new PendingRequests(now)
  assert.throws(
    () => pending.answer('too late'),
    (thrown: unknown) => (thrown as { code?: string }).code === 'not_found',
  )
  assert.throws(
    () => pending.respond('allow'),
    (thrown: unknown) => (thrown as { code?: string }).code === 'not_found',
  )
})

test('the snapshot is frozen so a caller cannot resolve a waiter by editing it', () => {
  const pending = new PendingRequests(now)
  pending.ask(turnA, [{ question: 'Which?', options: [{ label: 'x' }] }])
  const question = pending.ask(turnA, [{ question: 'Which?' }]).open
  assert.throws(() => {
    ;(question as { questionId: string }).questionId = 'qst_0000000000000000'
  })
})
