/**
 * The socket's request/response surface (§2).
 *
 * Two properties matter more than any single method: a client that sends
 * nonsense gets a typed error rather than taking the daemon down, and a
 * response carries back the `id` it was asked with so a client can match them.
 *
 * The wire itself — the method set, the params, the envelopes — is asserted in
 * `packages/foundation/contracts/test/daemon-rpc.test.ts`, against the file both
 * apps build from. What is left here is the daemon's own half: the decode, the
 * dispatch, and `encodeLine` framing what `handleLine` answered.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MessageId, PeerId, Seq, Sha } from '@fleet/foundation-core'
import type { DaemonApi, Decision } from '@fleet/foundation-contracts'
import { decodeRequest, dispatch, encodeLine, handleLine } from '../src/rpc.ts'

const SHA = 'ffcd0091a2b3c4d5' as Sha

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
      return { status, peers: [], routines: [], decisions: [] }
    },
    async send(input) {
      calls.push(`send:${String(input.to)}:${input.kind}:${String(input.briefVersion)}`)
      return { msgId: 'msg_0000000000000001' as MessageId }
    },
    async peek(input) {
      calls.push(`peek:${String(input.peer)}`)
      return { messages: [] }
    },
    async usage(input) {
      calls.push(`usage:${String(input.peerId)}`)
      return { recorded: true } as const
    },
    async eventsAppend(input) {
      calls.push(`events.append:${String(input.events.length)}`)
      return { seqs: input.events.map((_, index) => (index + 1) as Seq) }
    },
    async evals(input) {
      calls.push(`evals:${String(input.runId)}`)
      return {
        run: {
          runId: input.runId,
          suite: 'judge' as const,
          sha: SHA,
          provider: 'deepinfra',
          model: 'deepseek-ai/DeepSeek-V3.2',
          cases: 1,
          state: 'finished' as const,
          passed: 1,
          startedAt: '2026-11-10T10:00:00.000Z',
        },
        cases: [],
      }
    },
    async decide(input) {
      calls.push(`decide:${String(input.id)}:${input.decision}`)
      const answered: Decision = {
        decisionId: input.id,
        kind: 'merge_pr',
        state: 'answered',
        question: 'merge?',
        options: ['yes', 'no'],
        option: input.decision,
        inputsHash: 'hash-0001',
        requestedAt: '2026-11-10T10:00:00.000Z',
        answeredAt: '2026-11-10T10:01:00.000Z',
      }
      return answered
    },
  }
}

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

test('evals takes a run id, and a run id is what it takes', async () => {
  const subject = api()
  await dispatch(subject, { method: 'evals', params: { runId: 'evr_4c1d9a7b2e5f6038' } })
  assert.deepEqual(subject.calls, ['evals:evr_4c1d9a7b2e5f6038'])
  // The id is not a free string: a suite name or a bare number is the client's mistake, named.
  await assert.rejects(() => dispatch(api(), { method: 'evals', params: { runId: 'judge' } }), /runId/)
})

test('a bad peer id names the field, not just "params is invalid"', async () => {  await assert.rejects(
    () => dispatch(api(), { method: 'send', params: { to: 'Engineer 1', kind: 'info', body: 'x' } }),
    /to/,
  )
})

test('a line is one JSON object and one newline, which is what the server writes', () => {
  const line = encodeLine({ id: 'a1', ok: true, result: status })
  assert.equal(line.endsWith('\n'), true)
  assert.equal(line.indexOf('\n'), line.length - 1, 'the newline is the frame, and there is only one')
  assert.deepEqual(JSON.parse(line), { id: 'a1', ok: true, result: status })
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

test('events.append hands a run its seqs, in order, and refuses a non-eval event', async () => {
  const subject = api()
  const event = {
    type: 'eval.case_scored',
    ts: '2026-11-10T10:00:00.000Z',
    subject: 'evr_0123456789abcdef',
    actor: 'judge:some-model',
    data: { runId: 'evr_0123456789abcdef', caseId: 'stale-brief', attempt: 1, pass: true, score: 1, detail: 'ok' },
  }
  const result = await dispatch(subject, { method: 'events.append', params: { events: [event, event] } })
  assert.deepEqual(subject.calls, ['events.append:2'])
  assert.deepEqual(result, { seqs: [1, 2] })

  // The daemon is not the one keeping evals out: the contract does, and it does it
  // at the wire, before a single event reaches the store (§17).
  await assert.rejects(
    () => dispatch(subject, { method: 'events.append', params: { events: [{ ...event, type: 'turn.usage_recorded' }] } }),
    /eval\./,
  )
})
