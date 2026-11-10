/**
 * The event stream against the contract (§4).
 *
 * Contracts E widened `ProviderEvent` to carry what this adapter used to project
 * away, so the question is no longer "what does the projection lose" but "does
 * every event `events()` hands over actually validate as a `ProviderEvent`,
 * and are the two internal ones the only thing held back". `parse` is the
 * arbiter, not a second hand-written shape in this file.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parse, parseStrict, type TurnId } from '@fleet/foundation-core'
import { providerEvent } from '@fleet/foundation-contracts'
import type { QuestionId } from '@fleet/runtime-provider-sdk'

import { isContractEvent, type AdapterEvent } from '../src/index.ts'

const turn = 'trn_0123456789abcdef' as TurnId
const at = '2026-08-20T10:00:00.000Z'
const questionId = 'qst_0123456789abcdef' as QuestionId

/** Every event the adapter can emit, one of each kind — the whole vocabulary in one array. */
const everyEvent: readonly AdapterEvent[] = [
  { type: 'session.started', at, sessionRef: 'sess_0123456789abcdef' as never, model: 'claude-opus-5-5', permissionMode: 'default' },
  { type: 'turn.started', turnId: turn, at },
  { type: 'turn.ended', turnId: turn, at, reason: 'completed', usage: { contextTokens: 12, contextLimit: 200_000 } },
  { type: 'turn.ended', turnId: turn, at, reason: 'failed', error: 'the process died mid-turn' },
  { type: 'tool.use', turnId: turn, tool: 'Bash', summary: 'pnpm test' },
  { type: 'tool.denied', turnId: turn, tool: 'Write', summary: 'src/index.ts' },
  { type: 'question.asked', turnId: turn, questionId, questions: [{ question: 'Which channel?', header: 'Channel' }] },
  { type: 'question.abandoned', questionId },
  { type: 'approval.requested', turnId: turn, requestId: 'apr_0123456789abcdef', tool: 'Bash', summary: 'rm -rf build' },
  { type: 'session.ended', reason: 'stopped' },
  { type: 'session.ended', reason: 'exit', code: 0 },
  { type: 'error', message: 'boom', retryable: false },
  { type: 'compaction', turnId: turn, contextTokensBefore: 15492, contextTokensAfter: 4476 },
]

test('every event events() hands over validates as a ProviderEvent', () => {
  const handed = everyEvent.filter(isContractEvent)
  assert.equal(handed.length, everyEvent.length - 2)
  for (const event of handed) {
    assert.doesNotThrow(() => parse(providerEvent(), event), `contract rejects ${event.type}`)
  }
})

test('the only events held back are the two the contract has no member for', () => {
  const held = everyEvent.filter((event) => !isContractEvent(event)).map((event) => event.type)
  assert.deepEqual(held, ['session.started', 'tool.denied'])
})

test('a question is answered by the id on the event, so the id must be a contract QuestionId', () => {
  const asked = everyEvent.filter(isContractEvent).find((event) => event.type === 'question.asked')
  assert.ok(asked !== undefined)
  assert.equal(parse(providerEvent(), asked).type, 'question.asked')
})

test('a session.ended that names a failure the contract cannot carry is refused', () => {
  // The adapter says `crash`, and the message travels as a separate `error`
  // event; smuggling the text onto `session.ended` would fail the contract.
  assert.throws(() => parseStrict(providerEvent(), { type: 'session.ended', reason: 'crash', error: 'boom' }))
})
