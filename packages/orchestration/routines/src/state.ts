/**
 * The projections as a value: what a pure `decide` is handed (§5.2, §5.4).
 *
 * The PM reads a `FleetState`, never the store, so a tick cannot read twice and
 * see two fleets, and a test states the fleet it wants instead of arranging one.
 * Somebody has to take the snapshot, and that somebody is the routine: it is
 * the only layer that runs on a clock and may await the store.
 *
 * Sessions belong to a peer (§3) but the snapshot needs all of them, and
 * `ReadModel.sessions.all()` answers that in one read: gathering per peer made
 * the snapshot's cost a function of the fleet's size, which is the one thing a
 * heartbeat cannot afford to be.
 */

import type { FleetState, ReadModel } from '@fleet/foundation-contracts'

export const snapshot = async (read: ReadModel): Promise<FleetState> => {
  const [peers, sessions, work, decisions, messages, pullRequests, worktrees, routines, findings, notifications] =
    await Promise.all([
      read.peers.all(),
      read.sessions.all(),
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
    sessions,
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
