/** `peer.watch` on the wire: the frame a client reads is exactly what the daemon writes (watch-and-attach §6). */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseStrict, SchemaError } from '@fleet/foundation-core'
import {
  daemonProtocolVersion,
  daemonStatus,
  displayLine,
  displayLineMaxChars,
  watchFrame,
  watchParams,
} from '../src/index.ts'

const decode = (value: unknown) => parseStrict(watchFrame(), value)

test('the protocol starts at 1 and rides the daemon status', () => {
  assert.equal(daemonProtocolVersion, 1)
  const status = {
    profile: 'p',
    pid: 1,
    startedAt: '2026-11-11T08:00:00.000Z',
    socketPath: '/s',
    storePath: '/t',
    protocolVersion: daemonProtocolVersion,
  }
  assert.deepEqual(parseStrict(daemonStatus(), status), status)
  const { protocolVersion: _gone, ...old } = status
  assert.throws(() => parseStrict(daemonStatus(), old), SchemaError, 'a daemon that does not say its protocol is not one a client can trust')
})

test('every frame kind round-trips, with and without the request id', () => {
  const frames = [
    { id: '7', stream: 'line', seq: 3, at: '2026-11-11T08:00:00.000Z', peerId: 'engineer-1', line: { kind: 'text', text: 'hello' } },
    { stream: 'line', seq: 4, at: '2026-11-11T08:00:01.000Z', peerId: 'engineer-1', line: { kind: 'tool', tool: 'Bash', summary: 'ls' } },
    { stream: 'line', seq: 5, at: '2026-11-11T08:00:02.000Z', peerId: 'engineer-1', line: { kind: 'turn', phase: 'ended', reason: 'completed' } },
    { stream: 'row', seq: 6, at: '2026-11-11T08:00:03.000Z', row: { kind: 'state', peerId: 'engineer-1', state: 'idle' } },
    { stream: 'row', seq: 7, at: '2026-11-11T08:00:03.000Z', row: { kind: 'mail', phase: 'sent', msgId: 'msg_0123456789abcdef', to: 'engineer-1', from: 'user' } },
    { stream: 'row', seq: 8, at: '2026-11-11T08:00:03.000Z', row: { kind: 'decision', phase: 'requested', decisionId: 'dec_0123456789abcdef', question: 'merge?' } },
    { id: '7', stream: 'ready', seq: 8, from: 1, protocolVersion: 1 },
    { id: '7', stream: 'end', reason: 'dropped' },
  ]
  for (const frame of frames) assert.deepEqual(decode(frame), frame)
})

test('a frame with an unknown kind, a bad line or an extra field is refused, not passed along', () => {
  assert.throws(() => decode({ stream: 'bogus' }), SchemaError)
  assert.throws(() => decode({ stream: 'end', reason: 'because' }), SchemaError)
  assert.throws(
    () => decode({ stream: 'line', seq: 1, at: 'x', peerId: 'engineer-1', line: { kind: 'text', text: 'a', thinking: 'secret' } }),
    SchemaError,
    'a display line has no room for anything but what the view shows',
  )
  assert.throws(() => decode({ stream: 'line', seq: -1, at: 'x', peerId: 'engineer-1', line: { kind: 'text', text: 'a' } }), SchemaError)
})

test('a display line is bounded, so a peer printing a file cannot size the socket payload', () => {
  assert.ok(parseStrict(displayLine(), { kind: 'text', text: 'x'.repeat(displayLineMaxChars) }))
  assert.throws(() => parseStrict(displayLine(), { kind: 'text', text: 'x'.repeat(displayLineMaxChars + 2) }), SchemaError)
  assert.throws(() => parseStrict(displayLine(), { kind: 'turn', phase: 'paused' }), SchemaError)
})

test('watch params take an optional peer and an optional last-seen seq, and nothing else', () => {
  assert.deepEqual(parseStrict(watchParams(), {}), {})
  assert.deepEqual(parseStrict(watchParams(), { peerId: 'engineer-1', since: 12 }), { peerId: 'engineer-1', since: 12 })
  assert.throws(() => parseStrict(watchParams(), { since: -1 }), SchemaError)
  assert.throws(() => parseStrict(watchParams(), { limit: 5 }), SchemaError)
})
