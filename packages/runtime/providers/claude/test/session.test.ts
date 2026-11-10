/**
 * A session that never reaches `init` (§4, TASK-17).
 *
 * The case this exists for: the provider's OAuth token expired, the CLI ended
 * the query with `is_error`, and `peer.failed` read "session did not initialise
 * in 60000ms" — the timeout we waited, not the sentence the provider had
 * already sent. A stand-in `query` is the only way to drive that without a CLI,
 * which is what `ClaudeSessionConfig.query` is for.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PeerId } from '@fleet/foundation-core'
import type { SessionSpec } from '@fleet/runtime-provider-sdk'

import { ClaudeProvider } from '../src/provider.ts'
import type { QueryFactory } from '../src/session.ts'

/** A `query` stand-in: the script is the SDK's message stream, and nothing else is called. */
const queryThat = (script: () => AsyncGenerator<unknown>): QueryFactory =>
  (() => ({
    [Symbol.asyncIterator]: script,
    close: () => undefined,
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setPermissionMode: async () => undefined,
    getContextUsage: async () => ({}),
  })) as unknown as QueryFactory

const spec = (): SessionSpec => ({
  peerId: 'peer-1' as PeerId,
  role: 'engineer',
  cwd: process.cwd(),
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
  env: {},
  brief: {
    briefId: 'brf_00000000000000b7' as SessionSpec['brief']['briefId'],
    version: 1,
    contractVersions: [],
    text: 'Build the thing.',
  },
})

test('a session that ends before init fails with the provider’s own error, not the timeout (§4)', async () => {
  const started = Date.now()
  const provider = new ClaudeProvider({
    // Long on purpose: the assertion below is that this is never waited out.
    initTimeoutMs: 60_000,
    query: queryThat(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'OAuth token has expired · run /login to renew it',
      }
    }),
  })

  await assert.rejects(provider.start(spec()), (thrown: unknown) => {
    assert.ok(thrown instanceof Error)
    assert.match(thrown.message, /ended before it initialised/)
    assert.match(thrown.message, /OAuth token has expired/)
    assert.doesNotMatch(thrown.message, /did not initialise in/)
    return true
  })
  assert.ok(Date.now() - started < 10_000, 'the cause was known as soon as the stream ended')
})

test('a session whose stream throws before init carries the thrown sentence (§4)', async () => {
  const provider = new ClaudeProvider({
    initTimeoutMs: 60_000,
    query: queryThat(async function* () {
      throw new Error('Invalid API key · please run /login')
    }),
  })

  await assert.rejects(provider.start(spec()), /Invalid API key/)
})

test('a session that simply never answers is still the timeout (§4)', async () => {
  const provider = new ClaudeProvider({
    initTimeoutMs: 50,
    query: queryThat(async function* () {
      await new Promise(() => undefined)
    }),
  })

  // The session's own timeout timer is unref'd on purpose — a provider that never
  // answers must not keep the process alive — so this test has to hold the loop
  // itself. Without it the runner finds nothing pending, cancels the test with
  // "Promise resolution is still pending but the event loop has already resolved"
  // and the timeout never gets to fire.
  const holding = setInterval(() => undefined, 1_000)
  try {
    await assert.rejects(provider.start(spec()), /did not initialise in 50ms/)
  } finally {
    clearInterval(holding)
  }
})
