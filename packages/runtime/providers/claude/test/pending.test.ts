/**
 * The pending map is what makes `waiting_input` a fact rather than an
 * inference (§4): a question or an approval that is open blocks the turn, and
 * one that is abandoned must unblock it — leaving a promise unsettled parks the
 * session forever, which is the one failure the spike found the SDK will not
 * recover from on its own.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { newQuestionId, type TurnId } from '@fleet/foundation-core'

import { PendingRequests } from '../src/index.ts'

const turnA = 'trn_aaaaaaaaaaaaaaaa' as TurnId
const turnB = 'trn_bbbbbbbbbbbbbbbb' as TurnId
const now = (): string => '2026-08-20T10:00:00.000Z'

test('a question blocks until it is answered by id', async () => {
  const pending = new PendingRequests(now)
  const { open, wait } = pending.ask(turnA, [{ question: 'Which channel?' }])
  assert.equal(pending.blocked, true)
  assert.match(open.questionId, /^qst_[0-9a-f]{16}$/)

  pending.answer(open.questionId, ['Blue'])
  assert.deepEqual(await wait, ['Blue'])
  assert.equal(pending.blocked, false)
})

test('an answer addresses one question by id and leaves the others alone', async () => {
  const pending = new PendingRequests(now)
  const first = pending.ask(turnA, [{ question: 'First?' }])
  const second = pending.ask(turnB, [{ question: 'Second?' }])

  pending.answer(second.open.questionId, ['to the second'])
  assert.deepEqual(await second.wait, ['to the second'])
  assert.equal(pending.snapshot().questions[0]?.questionId, first.open.questionId)
})

test('an approval resolves to allow or deny and reports which', async () => {
  const pending = new PendingRequests(now)
  const allowed = pending.askApproval(turnA, 'Bash', 'rm -rf build')
  const denied = pending.askApproval(turnA, 'Write', '/etc/hosts')
  assert.match(allowed.open.requestId, /^apr_[0-9a-f]{16}$/)

  pending.respond(allowed.open.requestId, 'allow')
  pending.respond(denied.open.requestId, 'deny')
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
  assert.deepEqual(await a.wait, [])
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
    () => pending.answer(newQuestionId(), ['too late']),
    (thrown: unknown) => (thrown as { code?: string }).code === 'not_found',
  )
  assert.throws(
    () => pending.respond('apr_0000000000000000', 'allow'),
    (thrown: unknown) => (thrown as { code?: string }).code === 'not_found',
  )
})

test('the snapshot is frozen so a caller cannot resolve a waiter by editing it', () => {
  const pending = new PendingRequests(now)
  pending.ask(turnA, [{ question: 'Which?', options: [{ label: 'x' }] }])
  const question = pending.ask(turnA, [{ question: 'Which?' }]).open
  assert.throws(() => {
    ;(question as { questionId: string }).questionId = newQuestionId()
  })
})
