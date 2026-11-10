/**
 * The socket's request/response surface (§2).
 *
 * Two properties matter more than any single method: a client that sends
 * nonsense gets a typed error rather than taking the daemon down, and a
 * response carries back the `id` it was asked with so a client can match them.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DecisionId, PeerId } from '@fleet/foundation-core'
import { decodeRequest, dispatch, encodeLine, handleLine, type DaemonApi } from '../src/rpc.ts'

const status = {
  profile: 'test',
  pid: 4242,
  startedAt: '2026-11-10T10:00:00.000Z',
  socketPath: '/tmp/fleetd.sock',
  storePath: '/tmp/store.sqlite',
}

/** A DaemonApi that records what it was asked and answers with fixed rows. */
const api = (): DaemonApi & { readonly calls: readonly string[] } => {
  const calls: string[] = []
  return {
    calls,
    async up() {
      calls.push('up')
      return status
    },
    async down() {
      calls.push('down')
      return { stopped: true } as const
    },
    async ls() {
      calls.push('ls')
      return { status, peers: [], routines: [] }
    },
    async send(input) {
      calls.push(`send:${String(input.to)}:${input.kind}:${String(input.briefVersion)}`)
      return { msgId: 'msg_0000000000000001' }
    },
    async peek(input) {
      calls.push(`peek:${String(input.peer)}`)
      return { messages: [] }
    },
    async usage(input) {
      calls.push(`usage:${String(input.peerId)}`)
      return { recorded: true } as const
    },
    async decide(input) {
      calls.push(`decide:${String(input.id)}:${input.decision}`)
      return {
        id: input.id as DecisionId,
        kind: 'merge_pr',
        state: 'answered',
        question: 'merge?',
        options: ['yes', 'no'],
        requestedAt: '2026-11-10T10:00:00.000Z',
      }
    },
  }
}

test('a request decodes, dispatches and round-trips through one line', async () => {
  const subject = api()
  const response = await handleLine(subject, '{"id":"a1","method":"up"}')

  assert.deepEqual(response, { id: 'a1', ok: true, result: status })
  assert.deepEqual(subject.calls, ['up'])
  assert.equal(encodeLine(response).endsWith('\n'), true)
  assert.deepEqual(JSON.parse(encodeLine(response)), response, 'the wire format is JSON lines')
})

test('send passes its params through, decoded', async () => {
  const subject = api()
  await dispatch(subject, {
    method: 'send',
    params: { to: 'engineer-1' as PeerId, kind: 'info', body: 'hello', briefVersion: 3 },
  })
  assert.deepEqual(subject.calls, ['send:engineer-1:info:3'])
})

test('usage decodes its report strictly and a bad field is named', async () => {
  const subject = api()
  const report = {
    peerId: 'engineer-1',
    contextTokens: 10,
    contextLimit: 200_000,
    inputTokens: 5,
    outputTokens: 5,
    cachedTokens: 0,
    toolCalls: { grep: 0, glob: 0, read: 1, codegraph: 0 },
  }
  await dispatch(subject, { method: 'usage', params: report })
  assert.deepEqual(subject.calls, ['usage:engineer-1'])
  await assert.rejects(() => dispatch(subject, { method: 'usage', params: { ...report, contextLimit: 0 } }), /contextLimit/)
})

test('a bad peer id names the field, not just "params is invalid"', async () => {
  await assert.rejects(
    () => dispatch(api(), { method: 'send', params: { to: 'Engineer 1', kind: 'info', body: 'x' } }),
    /to/,
  )
})

test('an unknown method is refused', () => {
  assert.throws(() => decodeRequest('{"method":"restart"}'), /method/)
})

test('a request that is not JSON says so instead of throwing a SyntaxError', () => {
  assert.throws(() => decodeRequest('not json at all'), /not JSON/)
})

test('an unknown key is refused: strict at the wire, tolerant nowhere', () => {
  assert.throws(() => decodeRequest('{"method":"restart"}'), /method/)
  assert.throws(() => decodeRequest('{"method":"up","sneaky":true}'), /unknown field/)
})

test('a schema failure is the client fault, not `internal`', async () => {
  const response = await handleLine(api(), '{"method":"up","params":{"sneaky":true}}')
  assert.equal(response.ok, false)
  assert.equal(response.ok === false ? response.error.code : '', 'invalid_input')
})

test('handleLine never throws — a nonsense line is an error response', async () => {
  const response = await handleLine(api(), '{"method":"nope"}')
  assert.equal(response.ok, false)
  assert.equal(response.ok === false ? response.error.code : '', 'invalid_input')
})

test('a caller-supplied id comes back even when the call failed', async () => {
  const response = await handleLine(api(), '{"id":"b2","method":"send","params":{"to":"nope!"}}')
  assert.equal(response.ok, false)
  assert.equal(response.id, 'b2')
})

test('a failure inside the daemon becomes an error response, not a crash', async () => {
  const exploding: DaemonApi = {
    ...api(),
    async ls() {
      throw new Error('the store is gone')
    },
  }
  const response = await handleLine(exploding, '{"method":"ls"}')
  assert.equal(response.ok, false)
  assert.equal(response.ok === false ? response.error.code : '', 'internal')
  assert.match(response.ok === false ? response.error.message : '', /the store is gone/)
})

test('methods that take no params refuse params', async () => {
  await assert.rejects(() => dispatch(api(), { method: 'down', params: { now: true } }), /unknown field/)
})

test('decide validates the decision id format before calling the daemon', async () => {
  await assert.rejects(() => dispatch(api(), { method: 'decide', params: { id: 'nope', decision: 'yes' } }), /id/)
})
