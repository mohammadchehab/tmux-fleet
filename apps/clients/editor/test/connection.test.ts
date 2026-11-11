/**
 * The four states a window can be in (§7), and the one rule they share: a poll
 * that failed is a state, never a rejection for the caller to handle.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FleetConnection, PROTOCOL_VERSION, type FleetState } from '../src/connection.ts'
import type { Discovery } from '../src/discovery.ts'
import { lsOf, peerOf } from './fixtures.ts'

const connection = (
  discovery: Discovery,
  list: () => Promise<ReturnType<typeof lsOf>>,
  states: FleetState[] = [],
): FleetConnection =>
  new FleetConnection({
    discover: async () => discovery,
    list: () => list(),
    onState: (state) => states.push(state),
  })

const SOCKET = '/home/tester/.fleet/tmux-fleet/daemon/fleetd.sock'
const socketed: Discovery = { kind: 'socket', socketPath: SOCKET, profile: 'tmux-fleet', via: 'profile' }

test('nothing running is a state with no socket, not an error', async () => {
  const states: FleetState[] = []
  const found = await connection({ kind: 'none' }, async () => lsOf(), states).poll()
  assert.deepEqual(found, { phase: 'no-fleet' })
  assert.deepEqual(states, [{ phase: 'no-fleet' }])
})

test('several running profiles become the one question', async () => {
  const found = await connection({ kind: 'choose', profiles: ['a', 'b'] }, async () => lsOf()).poll()
  assert.deepEqual(found, { phase: 'choose', profiles: ['a', 'b'] })
})

test('a fleet that answers is connected, with its rows', async () => {
  const found = await connection(socketed, async () => lsOf({ peers: [peerOf('engineer-1')] })).poll()
  assert.equal(found.phase, 'connected')
  assert.ok(found.phase === 'connected')
  assert.equal(found.profile, 'tmux-fleet')
  assert.equal(found.rows.peers.length, 1)
})

test('a failed poll disconnects and keeps the last rows', async () => {
  let fail = false
  const found = connection(socketed, async () => {
    if (fail) throw new Error('ENOENT: no such file or directory')
    return lsOf({ peers: [peerOf('engineer-1')] })
  })

  assert.equal((await found.poll()).phase, 'connected')
  fail = true
  const state = await found.poll()

  assert.equal(state.phase, 'disconnected')
  assert.ok(state.phase === 'disconnected')
  assert.match(state.reason, /ENOENT/)
  assert.equal(state.rows?.peers.length, 1, 'a lost daemon must not look like an empty fleet')

  // And again, while still down: the rows must survive a second failure too.
  const again = await found.poll()
  assert.ok(again.phase === 'disconnected')
  assert.equal(again.rows?.peers.length, 1)
})

test('a poll never rejects, whatever the daemon does', async () => {
  const found = connection(socketed, async () => {
    throw new Error('boom')
  })
  await assert.doesNotReject(async () => found.poll())
})

test('a discovery that throws is a state, and the next poll still runs', async () => {
  // Discovery is I/O — settings, the environment, a scan of `~/.fleet` — and it
  // used to sit outside the guard. A rejection there escaped the `void poll()` of
  // the interval, so the window kept its last state and never asked again.
  const states: FleetState[] = []
  let broken = true
  const found = new FleetConnection({
    discover: async () => {
      if (broken) throw new Error('EACCES: permission denied, scandir /home/tester/.fleet')
      return socketed
    },
    list: async () => lsOf({ peers: [peerOf('engineer-1')] }),
    onState: (state) => states.push(state),
  })

  const first = await found.poll()
  assert.equal(first.phase, 'problem')
  assert.ok(first.phase === 'problem')
  assert.match(first.reason, /EACCES/)

  broken = false
  const second = await found.poll()
  assert.equal(second.phase, 'connected', 'a settings problem must not end the loop')
  assert.deepEqual(
    states.map((state) => state.phase),
    ['problem', 'connected'],
  )
})

test('a profile setting the layout rejects is the same state, and says which setting', async () => {
  const found = await connection({ kind: 'invalid', reason: 'fleet.profile "../elsewhere" is not a profile name' }, async () => lsOf()).poll()
  assert.equal(found.phase, 'problem')
  assert.ok(found.phase === 'problem')
  assert.match(found.reason, /fleet\.profile/)
})

test('a daemon that speaks another protocol is its own state, with the number', async () => {
  const ls = { ...lsOf(), status: { ...lsOf().status, protocolVersion: PROTOCOL_VERSION + 1 } }
  const found = await connection(socketed, async () => ls).poll()
  assert.deepEqual(found, { phase: 'version-mismatch', socketPath: SOCKET, daemonVersion: PROTOCOL_VERSION + 1 })
})

test('a daemon that says nothing about its protocol is not failed for it', async () => {
  const found = await connection(socketed, async () => lsOf()).poll()
  assert.equal(found.phase, 'connected')
})

test('the socket the last poll used is the one the actions reuse', async () => {
  const found = connection(socketed, async () => lsOf())
  await found.poll()
  assert.equal(found.socket(), SOCKET)
})
