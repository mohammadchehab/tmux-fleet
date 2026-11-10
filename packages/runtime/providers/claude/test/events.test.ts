/**
 * The projection onto the current `ProviderEvent` union (§4). It is lossy, and
 * these tests are the record of exactly how: a supervisor reading `events()`
 * today can tell that a peer is blocked on a person, but not whether it was a
 * question or an approval, and it never learns that the session ended.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TurnId } from '@fleet/foundation-core'

import { toContract } from '../src/index.ts'

const turn = 'trn_0123456789abcdef' as TurnId
const at = '2026-08-20T10:00:00.000Z'

test('turn events project unchanged, including usage when it exists', () => {
  assert.deepEqual(toContract({ type: 'turn.started', turnId: turn, at }), { type: 'turn.started', turnId: turn, at })
  const usage = { contextTokens: 12, contextLimit: 200_000 }
  assert.deepEqual(toContract({ type: 'turn.ended', turnId: turn, at, reason: 'completed', usage }), {
    type: 'turn.ended',
    turnId: turn,
    at,
    usage,
  })
})

test('the reason on turn.ended has no contract field yet, and is dropped rather than smuggled in', () => {
  assert.deepEqual(toContract({ type: 'turn.ended', turnId: turn, at, reason: 'failed', error: 'boom' }), {
    type: 'turn.ended',
    turnId: turn,
    at,
  })
})

test('a question projects its first question, and counts the rest', () => {
  assert.deepEqual(
    toContract({
      type: 'question.asked',
      turnId: turn,
      questionId: 'qst_0123456789abcdef',
      at,
      questions: [{ question: 'Which channel?' }, { question: 'And when?' }],
    }),
    { type: 'question.asked', turnId: turn, question: 'Which channel? (and 1 more)' },
  )
})

test('a blocked approval projects to a question.asked, because waiting_input must not be missed', () => {
  assert.deepEqual(
    toContract({
      type: 'approval.requested',
      turnId: turn,
      requestId: 'apr_0123456789abcdef',
      at,
      tool: 'Bash',
      summary: 'rm -rf build',
    }),
    { type: 'question.asked', turnId: turn, question: 'Approve Bash: rm -rf build?' },
  )
})

test('session.started, session.ended and the abandon/resolve events have no contract form yet', () => {
  assert.equal(
    toContract({ type: 'session.started', at, sessionRef: 'sess_x' as never, model: 'm', permissionMode: 'default' }),
    undefined,
  )
  assert.equal(toContract({ type: 'session.ended', at, reason: 'exited' }), undefined)
  assert.equal(toContract({ type: 'question.abandoned', questionId: 'qst_x', reason: 'interrupted' }), undefined)
  assert.equal(toContract({ type: 'approval.resolved', requestId: 'apr_x', decision: 'allow' }), undefined)
})

test('errors and compaction pass through', () => {
  assert.deepEqual(toContract({ type: 'error', message: 'boom', retryable: false }), {
    type: 'error',
    message: 'boom',
    retryable: false,
  })
  assert.deepEqual(
    toContract({ type: 'compaction', turnId: turn, contextTokensBefore: 15492, contextTokensAfter: 4476 }),
    { type: 'compaction', turnId: turn, contextTokensBefore: 15492, contextTokensAfter: 4476 },
  )
})
