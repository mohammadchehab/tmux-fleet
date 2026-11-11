/**
 * A peer deliberately not running (watch-and-attach §4, §7.2): the projection
 * says so, and a store reopened by a restarted daemon still says so.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PeerId } from '@fleet/foundation-core'
import type { AppendEvent } from '@fleet/foundation-contracts'
import { openSqliteStore } from '../src/index.ts'
import { fixedClock, tempStorePath } from './fixtures.ts'

const peerId = 'engineer-1' as PeerId
const ref = '1d61f8ce-5fe5-45cf-8273-3f06cab62c86'
const at = '2026-11-11T09:00:00.000Z'
const ev = (type: string, data: Record<string, unknown>, actor = 'user'): AppendEvent =>
  ({ ts: at, type, subject: peerId, actor, data }) as unknown as AppendEvent

const registered = ev('peer.registered', { peerId, role: 'engineer', providerId: 'claude', model: 'claude-opus-5-5', permissionMode: 'default' })
const started = ev(
  'session.started',
  { peerId, sessionId: 'ses_aaaaaaaaaaaaaaaa', providerId: 'claude', providerSessionRef: ref, model: 'claude-opus-5-5', permissionMode: 'default', resumed: false },
  'peer:engineer-1',
)
const working = ev('peer.state_changed', { peerId, state: 'working', sessionId: 'ses_aaaaaaaaaaaaaaaa' }, 'peer:engineer-1')

test('a held peer reads held with no current session, and its ref is still its last session\'s', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  await store.append([registered, started, working, ev('peer.held', { peerId, sessionRef: ref, by: 'user' })])
  const peer = await store.reader().peers.get(peerId)
  assert.equal(peer?.state, 'held')
  assert.equal(peer?.currentSessionId, undefined)
  assert.equal((await store.reader().sessions.forPeer(peerId)).at(-1)?.providerSessionRef, ref)
  await store.close()

  // A daemon that restarts reads the hold back, and does not start a session over the person.
  const reopened = await openSqliteStore({ path, clock: fixedClock })
  assert.equal((await reopened.reader().peers.get(peerId))?.state, 'held')
  await reopened.append([ev('peer.released', { peerId, sessionRef: ref, resumed: true })])
  assert.equal((await reopened.reader().peers.get(peerId))?.state, 'starting')
  await reopened.close()
})

test('a stopped peer reads stopped until it is started', async () => {
  const store = await openSqliteStore({ path: tempStorePath(), clock: fixedClock })
  await store.append([registered, started, working, ev('peer.stopped', { peerId, sessionRef: ref, by: 'user' })])
  assert.equal((await store.reader().peers.get(peerId))?.state, 'stopped')
  await store.append([ev('peer.started', { peerId, sessionRef: ref, resumed: true })])
  assert.equal((await store.reader().peers.get(peerId))?.state, 'starting')
  await store.close()
})
