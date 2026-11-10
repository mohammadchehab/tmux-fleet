/**
 * The one-shot structured call (§5.3, §5.4): what a Judge question runs on.
 *
 * A model call is a process, so the only part of this file that can be tested
 * without spawning one is the part that deliberately does not: a budget that
 * expired before the call was made. That case is worth pinning precisely because
 * it is the one a timeout-heavy day hits most — a retry that starts after the
 * deadline must cost nothing, not spawn a session and then kill it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JUDGE_CALLER, createStructuredCompletion } from '../src/index.ts'

const request = (signal: AbortSignal) => ({
  system: 'You answer one question with JSON.',
  prompt: '{"question":"is this card thin?"}',
  schema: { type: 'object', properties: { thin: { type: 'boolean' } }, required: ['thin'] },
  model: 'claude-haiku-4-5',
  signal,
})

test('a call whose budget already expired is a timeout, and never spawns anything', async () => {
  const controller = new AbortController()
  controller.abort()
  const completion = createStructuredCompletion({
    // A directory that does not exist: anything that tried to start a session
    // here would fail as `provider_failed`, so the code proves the early return.
    cwd: '/nonexistent/fleet-judge-cwd',
  })

  await assert.rejects(
    completion.complete(request(controller.signal)),
    (thrown: unknown) => {
      const error = thrown as { code?: string; message?: string; details?: Record<string, unknown> }
      assert.equal(error.code, 'timeout')
      assert.match(error.message ?? '', /aborted before it started/)
      assert.equal(error.details?.['model'], 'claude-haiku-4-5')
      return true
    },
  )
})

test('a judge call reports itself as a peer id the event actor will accept (§3)', () => {
  // The transport runs with a peer-shaped environment; the id must be one the
  // actor and peer-id rules accept, or `judge.answered` cannot be written.
  assert.match(JUDGE_CALLER, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
})
