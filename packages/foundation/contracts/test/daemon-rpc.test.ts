/**
 * The daemon's wire (architecture §2).
 *
 * Two things are being pinned here, and they are different kinds of assertion:
 *
 * - **The methods and their params.** Every method in the closed set must have
 *   a params schema that accepts exactly what a client may send — so a method
 *   added to `daemonMethods` without a schema fails to compile, and one whose
 *   schema is too loose fails below.
 * - **The two envelopes are a discriminated union, not a shape.** `ok` decides
 *   which half a line is, so a line with `ok: false` and no `error` is refused
 *   rather than read as a failure with an undefined message. That is the
 *   contract's whole job for a client: it can branch on one field.
 *
 * The rows are not re-tested here. They are the projections, whose own fixtures
 * already hold them; a copy would be a second spelling of one row.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeStrict, parseStrict, SchemaError } from '@fleet/foundation-core'
import {
  daemonMethods,
  daemonParamsFor,
  daemonRequest,
  daemonResponse,
  daemonResultFor,
  daemonStatus,
  type DaemonMethod,
} from '../src/index.ts'

/** One `eval.case_scored`, the shape the eval runner hands the daemon (§17). */
const evalCaseScoredEvent = {
  type: 'eval.case_scored',
  ts: '2026-11-10T10:00:00.000Z',
  subject: 'evr_0123456789abcdef',
  actor: 'judge:some-model',
  data: { runId: 'evr_0123456789abcdef', caseId: 'stale-brief', attempt: 1, pass: true, score: 1, detail: 'matched' },
}

/** Params that must be accepted for a method; `{}` for the four that take nothing. */
const validParams: { readonly [M in DaemonMethod]: readonly unknown[] } = {
  up: [{}],
  down: [{}],
  ls: [{}],
  send: [
    { to: 'peer-1', kind: 'info', body: 'the checks are red' },
    { to: 'peer-1', kind: 'nudge', body: 'still red', briefVersion: 3 },
  ],
  peek: [{ peer: 'peer-1' }, { peer: 'peer-1', limit: 20 }],
  usage: [
    {
      peerId: 'peer-1',
      contextTokens: 1200,
      contextLimit: 200000,
      inputTokens: 900,
      outputTokens: 300,
      cachedTokens: 800,
      toolCalls: { grep: 1, glob: 0, read: 2, codegraph: 3 },
    },
  ],
  decide: [{ id: 'dec_0123456789abcdef', decision: 'yes' }, { id: 'dec_0123456789abcdef', decision: 'no', note: 'later' }],
  'events.append': [{ events: [evalCaseScoredEvent] }],
  evals: [{ runId: 'evr_4c1d9a7b2e5f6038' }],
  replay: [{}, { from: 3 }, { from: 3, to: 9 }, { from: 1, to: 1 }],
}

test('the method set is the one a client builds against, and the usage report a hook sends', () => {
  assert.deepEqual([...daemonMethods], [
    'up',
    'down',
    'ls',
    'send',
    'peek',
    'decide',
    'usage',
    'events.append',
    'evals',
    'replay',
  ])
})

for (const method of daemonMethods) {
  test(`params: ${method} accepts what a client sends`, () => {
    for (const params of validParams[method]) {
      const parsed = parseStrict(daemonParamsFor(method), params)
      assert.deepEqual(parsed, params, 'decode then encode returns the input unchanged')
    }
  })
}

test('a method that takes no params refuses one anyway', () => {
  // Strict mode is what makes this an error rather than a silent no-op: a client
  // that sends `{"limit":3}` to `ls` believes it filtered something.
  const refused = decodeStrict(daemonParamsFor('ls'), { limit: 3 })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.error.message, /limit/)
})

test('a bad field is named, not swallowed', () => {
  const refused = decodeStrict(daemonParamsFor('send'), { to: 'not a peer', kind: 'info', body: 'x' })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.error.message, /^to:/)
})

test('a message kind outside the closed set is refused', () => {
  const refused = decodeStrict(daemonParamsFor('send'), { to: 'peer-1', kind: 'chat', body: 'x' })
  assert.equal(refused.ok, false)
})

test('a decision id must be a decision id', () => {
  const refused = decodeStrict(daemonParamsFor('decide'), { id: 'yes-or-no', decision: 'yes' })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.error.message, /^id:/)
})

test('events.append is the evals\' door only: another event type is refused', () => {
  // §17: the runner is dev tooling that may not import the daemon, so this is the
  // one write it gets. It is not a general append with a narrower name — the
  // prefix is the suite's, and a client that widened it would be writing the log.
  const refused = decodeStrict(daemonParamsFor('events.append'), {
    events: [{ ...evalCaseScoredEvent, type: 'peer.registered' }],
  })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.error.message, /eval\./)
})

test('events.append refuses an empty batch', () => {
  assert.equal(decodeStrict(daemonParamsFor('events.append'), { events: [] }).ok, false)
})

test('events.append validates each event against its own schema, not just its prefix', () => {
  // A type that is `eval.*` but carries the wrong fields is still not appendable:
  // the store would refuse it, and the wire should say so where the client is.
  const refused = decodeStrict(daemonParamsFor('events.append'), {
    events: [{ ...evalCaseScoredEvent, data: { runId: 'evr_0123456789abcdef' } }],
  })
  assert.equal(refused.ok, false)
})

// ------------------------------------------------------------------ envelope

test('a request round-trips, with the id kept for the client to match on', () => {
  const request = { id: 'a1', method: 'peek', params: { peer: 'peer-1' } }
  assert.deepEqual(parseStrict(daemonRequest(), request), request)
})

test('params are the envelope\'s business only as far as being present', () => {
  // The envelope leaves `params` alone so the method can name the bad field.
  // Decoding it strictly here would answer "params is invalid" instead.
  const request = { method: 'send', params: { nonsense: true } }
  const parsed = parseStrict(daemonRequest(), request)
  assert.deepEqual(parsed.params, { nonsense: true })
})

test('an unknown method is refused at the envelope, before any params decode', () => {
  assert.throws(() => parseStrict(daemonRequest(), { method: 'restart' }), SchemaError)
})

test('a response is an ok half or a failed half, and `ok` decides which', () => {
  const ok = { id: 'a1', ok: true, result: { stopped: true } }
  assert.deepEqual(parseStrict(daemonResponse(), ok), ok)

  const failed = { id: 'a1', ok: false, error: { code: 'invalid_input', message: 'params.to: not a peer id' } }
  assert.deepEqual(parseStrict(daemonResponse(), failed), failed)
})

test('a failed response without an error is refused', () => {
  assert.throws(() => parseStrict(daemonResponse(), { ok: false }), SchemaError)
})

test('an ok response may carry any result, including none', () => {
  assert.deepEqual(parseStrict(daemonResponse(), { ok: true, result: null }), { ok: true, result: null })
})

test('a response without `ok` is neither half', () => {
  assert.throws(() => parseStrict(daemonResponse(), { result: { stopped: true } }), SchemaError)
})

test('a result is the method\'s own, so an ok payload is not silently another method\'s', () => {
  // The table is exhaustive by type; this is the runtime half — `ls` does not
  // accept `up`'s answer, so a client that mixed two methods up is told.
  const asStatusOnly = { profile: 'p', pid: 1, startedAt: '2026-11-10T10:00:00.000Z', socketPath: '/s', storePath: '/t' }
  assert.equal(decodeStrict(daemonResultFor('ls'), asStatusOnly).ok, false)
  assert.equal(decodeStrict(daemonResultFor('up'), asStatusOnly).ok, true)
})

test('the status is what `up` and `ls` both report', () => {
  const status = {
    profile: 'acme',
    pid: 4242,
    startedAt: '2026-11-10T09:00:00.000Z',
    socketPath: '/home/u/.fleet/acme/daemon/fleetd.sock',
    storePath: '/home/u/.fleet/acme/store/fleet.db',
  }
  assert.deepEqual(parseStrict(daemonStatus(), status), status)
  // The pid is positive because zero is "no process", which is not a running daemon.
  assert.throws(() => parseStrict(daemonStatus(), { ...status, pid: 0 }), SchemaError)
})
