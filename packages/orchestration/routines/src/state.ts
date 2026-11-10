/**
 * The projections as a value: what a pure `decide` is handed (§5.2, §5.4).
 *
 * The PM reads a `FleetState`, never the store, so a tick cannot read twice and
 * see two fleets, and a test states the fleet it wants instead of arranging one.
 * Somebody has to take the snapshot, and that somebody is the routine: it is
 * the only layer that runs on a clock and may await the store.
 *
 * Sessions have no `all()` on `ReadModel` — a session belongs to a peer (§3) —
 * so they are gathered per peer. That is one extra call per peer, which is the
 * price of a total snapshot and is bounded by the fleet's size, not the store's.
 */

import type { FleetState, ReadModel } from '@fleet/foundation-contracts'

export const snapshot = async (read: ReadModel): Promise<FleetState> => {
  const peers = await read.peers.all()
  const [sessions, work, decisions, messages, pullRequests, worktrees, routines, findings, notifications] =
    await Promise.all([
      Promise.all(peers.map((peer) => read.sessions.forPeer(peer.peerId))),
      read.work.all(),
      read.decisions.all(),
      read.messages.all(),
      read.pullRequests.all(),
      read.worktrees.all(),
      read.routines.all(),
      read.findings.all(),
      read.notifications.all(),
    ])

  return {
    peers,
    sessions: sessions.flat(),
    work,
    decisions,
    messages,
    pullRequests,
    worktrees,
    routines,
    findings,
    notifications,
  }
}
