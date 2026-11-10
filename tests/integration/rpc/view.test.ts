/**
 * The view and the daemon, over a real socket (§2).
 *
 * `roundtrip.test.ts` holds the CLI and the daemon together. This does the same
 * for the other client: `fleet-view` has its own copy of the framing (apps never
 * import each other, §1.1) and its own decoders, so "does it read the daemon the
 * way the daemon answers" is a question neither side can answer alone. What it
 * renders is asserted here against the answer `fleet ls` gets from the same
 * socket in the same state.
 *
 * `tests/integration` may import both apps; nothing else may.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { callerFor } from '../../../apps/clients/cli/src/client.ts'
import { formatLs } from '../../../apps/clients/cli/src/render.ts'
import { peerOnce, tableOnce } from '../../../apps/clients/view/src/view.ts'
import { callDaemon, callerFor as viewCallerFor } from '../../../apps/clients/view/src/client.ts'
import { createSandbox } from '../support/sandbox.ts'
import type { PeerId } from '../../../packages/foundation/core/src/index.ts'

const PEER = 'engineer-1' as PeerId

test('the view reads the same fleet the CLI does, over the same socket', async (t) => {
  const sandbox = await createSandbox()
  t.after(() => sandbox.stop())
  await callerFor({ socketPath: sandbox.paths.socketPath })('up', {})

  const cli = callerFor({ socketPath: sandbox.paths.socketPath })
  const view = viewCallerFor({ socketPath: sandbox.paths.socketPath })

  // One `ls`, two clients: the view's `tableOnce` and the CLI's `formatLs` must
  // agree about a row, because they are two renderings of one daemon answer.
  const listing = await cli('ls', {})
  const table = await tableOnce(view)
  for (const peer of listing.peers) {
    assert.ok(table.includes(String(peer.peerId)), `the table names ${String(peer.peerId)}`)
    assert.ok(table.includes(peer.state), `the table spells ${String(peer.peerId)}'s state as the store does`)
  }
  // Both status lines open the same way — profile, pid, when it came up — and
  // differ only in how they spell the timestamp, which is a rendering choice.
  const head = (text: string): string => (text.split('\n')[0] ?? '').split('  up since ')[0] ?? ''
  assert.equal(head(table), head(formatLs(listing)), 'both clients describe the daemon the same way')
  assert.match(table.split('\n')[1] ?? '', new RegExp(`^socket {2}${String(sandbox.paths.socketPath).replaceAll('.', '\\.')}$`))

  // One peer, as its pane: the identity and state on the first line, then the
  // fields the projection carries — read back from the same daemon answer.
  const row = listing.peers.find((peer) => peer.peerId === PEER)
  assert.ok(row, 'the sandbox profile declares engineer-1')
  const pane = await peerOnce(view, PEER)
  assert.equal(pane[0], `${PEER}  ${row.state}`)
  assert.ok(pane.includes(`  provider  ${row.providerId}/${row.model}`))
  assert.ok(pane.includes(`  brief     v${String(row.briefVersion)}`))
  assert.ok(pane.includes(`  session   ${row.currentSessionId ?? 'none'}`))

  // A name that is not registered is rendered as unknown, not as another peer.
  const unknown = await peerOnce(view, 'nobody-here' as PeerId)
  assert.equal(unknown[0], 'nobody-here')
  assert.match(unknown[1] ?? '', /no peer by that id/)

  // And a socket with nobody behind it is a refused connection the caller can
  // name, which is what a pane draws instead of exiting.
  await assert.rejects(
    () => callDaemon({ socketPath: `${sandbox.paths.socketPath}.gone` }, 'ls', {}),
    /cannot reach fleetd/,
  )
})
