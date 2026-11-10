/**
 * The view's one read and what it does with a bad answer — with the daemon
 * replaced by a function, so these are the branches a real socket would make
 * slow and hard to hit on purpose.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fleetError, type PeerId } from '@fleet/foundation-core'
import type { DaemonMethod } from '@fleet/foundation-contracts'

import type { Caller } from '../src/client.ts'
import { paneLines, peerOnce, tableOnce } from '../src/view.ts'
import { SESSION, lsFixture, peerFixture } from './fixtures.ts'

const PEER = 'engineer-1' as PeerId

/**
 * A caller that answers `ls` with this fleet and refuses anything else — which
 * also holds the view to its one-read promise: a renderer that started calling
 * something else would fail here rather than in a pane.
 */
const caller = (peers: ReturnType<typeof lsFixture>['peers']): Caller =>
  (async (method: DaemonMethod) => {
    if (method !== 'ls') throw fleetError('invalid_input', `the view only reads ls, not ${method}`)
    return lsFixture(peers)
  }) as unknown as Caller

describe('view: one read, two shapes', () => {
  it('prints the whole fleet from one `ls`', async () => {
    const text = await tableOnce(caller([peerFixture({ peerId: 'engineer-1', currentSessionId: SESSION })]))
    assert.match(text, /^firstrun {2}pid 4242/)
    assert.match(text, new RegExp(PEER))
  })

  it('renders one peer as its pane', async () => {
    assert.deepEqual(await peerOnce(caller([peerFixture({ peerId: PEER })]), PEER), [
      'engineer-1  working',
      '  role      engineer',
      '  provider  claude/opus',
      '  session   none',
      '  brief     v3',
      '  worktree  none',
      '  updated   2026-11-10 12:59:55',
    ])
  })

  it('says a peer is unknown rather than showing another peer`s row', async () => {
    const lines = await peerOnce(caller([peerFixture({ peerId: 'engineer-2' })]), PEER)
    assert.equal(lines[0], PEER)
    assert.match(lines[1] ?? '', /no peer by that id/)
  })
})

describe('view: a pane survives a bad tick', () => {
  it('draws the reason instead of throwing out of the render loop', async () => {
    const down = (async () => {
      throw fleetError('external_failed', 'cannot reach fleetd at /x/fleetd.sock: connect ENOENT')
    }) as unknown as Caller
    const lines = await paneLines(down, PEER)
    assert.equal(lines[0], PEER, 'the pane keeps the peer it was built for')
    assert.match(lines[1] ?? '', /cannot reach fleetd at \/x\/fleetd.sock/)
  })

  it('recovers on the next tick, because nothing was remembered', async () => {
    let stillDown = true
    const flaky = (async () => {
      if (stillDown) throw fleetError('external_failed', 'not yet')
      return lsFixture([peerFixture({ peerId: PEER })])
    }) as unknown as Caller
    assert.match((await paneLines(flaky, PEER))[1] ?? '', /not yet/)
    stillDown = false
    assert.equal((await paneLines(flaky, PEER))[0], 'engineer-1  working')
  })
})
