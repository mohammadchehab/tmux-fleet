/**
 * §5.2 `idle`: a peer that has sat idle past the threshold is spare capacity, and if there is nothing to give it,
 * the user should know — once per dry spell, not once per heartbeat.
 *
 * Both halves are facts, not state changes:
 *
 * - `flag_capacity` says a peer is free. The PM must not write a peer's state: it comes from the provider (§4), and
 *   a PM that wrote one it cannot observe would be inventing a fleet.
 * - `raise_no_work` is the "someone is free and nothing is ready" fact. The action's contract says the executor
 *   dedupes it, because only it can see whether it already said so (§5.2, §6.1).
 *
 * This rule needs a clock, and it only ever reads the one on the tick (`tick.at`), never `Date.now()`: two replays
 * of the same tick must decide the same thing (§5.4).
 */

import { isAssignable } from '@fleet/foundation-contracts'
import type { Peer } from '@fleet/foundation-contracts'
import { isLivePeer } from '../state.ts'
import { draft, type Draft, type Rule } from './context.ts'

/** How long a peer has been idle, in whole milliseconds. A clock that went backwards counts as "not yet". */
const idleMs = (peer: Peer, at: string): number => {
  const since = Date.parse(peer.updatedAt)
  const now = Date.parse(at)
  if (Number.isNaN(since) || Number.isNaN(now)) return 0
  return Math.max(0, now - since)
}

export const raiseCapacityGaps: Rule = (ctx) => {
  const tick = ctx.tick
  if (tick === undefined) return []

  // something ready means someone can be given it: that is `assign`'s business, not this rule's
  if (ctx.state.work.some((work) => isAssignable(work.state))) return []

  const threshold = ctx.options.idleMinutes * 60_000
  const idle = ctx.state.peers
    .filter((peer) => peer.state === 'idle' && isLivePeer(peer) && idleMs(peer, tick.at) >= threshold)
    .sort((a, b) => (String(a.peerId) < String(b.peerId) ? -1 : 1))
  if (idle.length === 0) return []

  const roles = new Set(idle.map((peer) => peer.role))
  const minutes = Math.round(threshold / 60_000)
  const drafts: Draft[] = idle.map((peer) =>
    draft(`capacity:${String(peer.peerId)}`, {
      kind: 'flag_capacity',
      causedBy: ctx.causedBy,
      peerId: peer.peerId,
      reason: `idle for at least ${minutes} minutes with no assignable Work`,
    }),
  )

  drafts.push(
    draft('no_work', {
      kind: 'raise_no_work',
      causedBy: ctx.causedBy,
      // §5.2: the role that is dry; absent when the fleet as a whole has nothing to do
      role: roles.size === 1 ? [...roles][0] : undefined,
      reason:
        `${idle.length} peer${idle.length === 1 ? '' : 's'} idle past ${minutes} minutes, ` +
        'and no Work item is ready to assign',
    }),
  )
  return drafts
}
