/**
 * What is waiting on a person (watch-and-attach §7.1). In v1 a person asked the
 * project-manager agent; in v2 the PM is a program with no session to ask, so the
 * watch answers the question itself, at the top, always.
 *
 * Every `open` decision, and every peer in `waiting_input`, oldest first.
 */

import type { Decision, LsResult, Peer } from '@fleet/foundation-contracts'

export type Need =
  | { readonly kind: 'decision'; readonly decision: Decision; readonly since: string }
  | { readonly kind: 'peer'; readonly peer: Peer; readonly since: string }

export const needsYou = (ls: Pick<LsResult, 'decisions' | 'peers'>): readonly Need[] => {
  const needs: Need[] = [
    ...ls.decisions.filter((row) => row.state === 'open').map((decision): Need => ({ kind: 'decision', decision, since: decision.requestedAt })),
    ...ls.peers.filter((peer) => peer.state === 'waiting_input').map((peer): Need => ({ kind: 'peer', peer, since: peer.updatedAt })),
  ]
  // Oldest first, and a tie keeps decisions ahead of peers: the order is stable, so a row does not jump.
  return needs.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.kind === b.kind ? 0 : a.kind === 'decision' ? -1 : 1))
}
