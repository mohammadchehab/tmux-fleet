/**
 * What the view asks the daemon, and what it does with a bad answer.
 *
 * One read — `ls` — feeds both shapes of the view. There is no `peer` method in
 * the daemon API and this client is not the place to invent one: `ls` is the
 * fleet's projections already gathered for a reader, and a pane is a reader that
 * wants one row of it. The cost is that a pane reads every peer's row to show
 * one; the alternative was a method on the API whose only caller would be a
 * renderer.
 *
 * A failure is rendered, never thrown at the pane. A view is watched, so the one
 * thing it must not do is exit: the daemon is restarted, or a fleet is brought up
 * under a running view, and the next tick is right again.
 */

import { toFleetError, type PeerId } from '@fleet/foundation-core'

import type { Caller } from './client.ts'
import { renderPaneFailure, renderPeer, renderTable, renderUnknownPeer } from './render.ts'

/** The whole fleet in one block, once. Throws when the daemon cannot be read: `--once` is a command, not a pane. */
export const tableOnce = async (call: Caller): Promise<string> => renderTable(await call('ls', {}))

/** One peer's pane, once. Throws for the same reason `tableOnce` does. */
export const peerOnce = async (call: Caller, peer: PeerId): Promise<readonly string[]> => {
  const result = await call('ls', {})
  const found = result.peers.find((row) => row.peerId === peer)
  return found === undefined ? renderUnknownPeer(peer) : renderPeer(found)
}

/**
 * One peer's pane on a tick: the same lines, or the reason they are not there,
 * which is what makes a pane survivable. `renderPaneFailure` is the only branch
 * that has a reason in it, so a live pane and a broken one are never confused.
 */
export const paneLines = async (call: Caller, peer: PeerId): Promise<readonly string[]> => {
  try {
    return await peerOnce(call, peer)
  } catch (thrown) {
    return renderPaneFailure(peer, toFleetError(thrown).message)
  }
}
