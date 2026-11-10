/**
 * The mapping is the fleet's only claim about what a peer is doing, so each
 * line of it is pinned: a `?` in a transcript never decides anything (§4).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { newQuestionId, newTurnId } from '@fleet/foundation-core'
import type { ProviderEvent } from '@fleet/foundation-contracts'

import { peerStateOf } from '../src/index.ts'

const turnId = newTurnId()

const cases: readonly { readonly event: ProviderEvent; readonly expected: ReturnType<typeof peerStateOf> }[] = [
  { event: { type: 'turn.started', turnId, at: '2026-11-10T09:00:00.000Z' }, expected: 'working' },
  { event: { type: 'tool.use', turnId, tool: 'Bash', summary: 'pnpm test' }, expected: 'working' },
  {
    event: { type: 'question.asked', turnId, questionId: newQuestionId(), questions: [{ question: 'Which?' }] },
    expected: 'waiting_input',
  },
  { event: { type: 'approval.requested', turnId, requestId: 'apr_1', tool: 'Write' }, expected: 'waiting_input' },
  { event: { type: 'question.abandoned', questionId: newQuestionId() }, expected: 'working' },
  { event: { type: 'approval.abandoned', requestId: 'apr_1' }, expected: 'working' },
  { event: { type: 'turn.ended', turnId, at: '2026-11-10T09:00:01.000Z', reason: 'completed' }, expected: 'idle' },
  { event: { type: 'turn.ended', turnId, at: '2026-11-10T09:00:01.000Z', reason: 'interrupted' }, expected: 'idle' },
  {
    event: { type: 'turn.ended', turnId, at: '2026-11-10T09:00:01.000Z', reason: 'failed', error: 'boom' },
    expected: 'failed',
  },
  { event: { type: 'session.ended', reason: 'exit', code: 0 }, expected: 'ended' },
  { event: { type: 'session.ended', reason: 'stopped' }, expected: 'ended' },
  { event: { type: 'session.ended', reason: 'crash', code: 1 }, expected: 'failed' },
  { event: { type: 'error', message: 'rate limited', retryable: true }, expected: 'failed' },
  {
    event: { type: 'compaction', turnId, trigger: 'auto', contextTokensBefore: 900, contextTokensAfter: 300 },
    expected: undefined,
  },
]

for (const { event, expected } of cases) {
  test(`${event.type}${'reason' in event ? ` (${String(event.reason)})` : ''} → ${String(expected)}`, () => {
    assert.equal(peerStateOf(event), expected)
  })
}

test('an interrupt is a decision, not a failure: nobody is paged for it', () => {
  assert.equal(peerStateOf({ type: 'turn.ended', turnId, at: '2026-11-10T09:00:01.000Z', reason: 'interrupted' }), 'idle')
})

test('compaction changes no state: the session is alive and smaller', () => {
  assert.equal(peerStateOf({ type: 'compaction', turnId, trigger: 'manual', contextTokensBefore: 10, contextTokensAfter: 2 }), undefined)
})
