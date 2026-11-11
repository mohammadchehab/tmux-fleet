/**
 * Which Work a peer is holding, read off the Work rows rather than trusted from the caller (§5.1).
 *
 * The states in which a Work is still the assignee's: `assigned` and `in_progress` are the obvious two;
 * `in_review`, `mergeable` and `blocked` are in the list because the peer has not let go of the Work at
 * any of them — a peer that opened a PR is still the one answering questions about it, and a blocked
 * peer is the one that says what it is blocked on. `merged`, `cleaned` and `cancelled` are over, and
 * `proposed`/`ready` have no assignee at all.
 */

import type { Work, WorkState } from '@fleet/foundation-contracts'
import type { PeerId } from '@fleet/foundation-core'

export const heldWorkStates: ReadonlySet<WorkState> = new Set(['assigned', 'in_progress', 'in_review', 'mergeable', 'blocked'])

/** Every Work the peer is still holding, in the order the rows came. */
export const heldWorksOf = (works: readonly Work[], peerId: PeerId): readonly Work[] =>
  works.filter((row) => row.assignee === peerId && heldWorkStates.has(row.state))
