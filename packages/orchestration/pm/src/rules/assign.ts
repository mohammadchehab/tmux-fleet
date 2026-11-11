/**
 * §5.2 `assign` — and the keep-busy half of the `keep-busy` routine (§6), which is the same rule.
 *
 * A peer in `idle` takes the next `ready` Work for its role, up to the PR cap, and gets it as a complete brief
 * (§5.2: "write `Brief` v+1, send; `Work → assigned`"). The brief travels inside the action because `decide` is
 * pure: it has no store to publish into and then hand an id back from (§12).
 *
 * Two details are deliberate:
 *
 * - A Work is handed out at most once per tick. A `FleetState` says a peer is `idle` until the `peer.state_changed`
 *   event lands, so without this a tick with two idle peers and one ready Work would emit two assigns for it.
 * - A Work the tick already questioned (§5.2 `dedupe`, `thin_card`) is skipped: the point of asking is to find out
 *   whether it should be done at all, and handing it over first answers the question the wrong way round.
 */

import { isAssignable } from '@fleet/foundation-contracts'
import type { Peer, Work } from '@fleet/foundation-contracts'
import { briefFor } from '../brief.ts'
import type { ContractVersionRef } from '@fleet/foundation-contracts'
import { byOrder, isLivePeer, workOrder } from '../state.ts'
import type { RuleContext } from './context.ts'
import { draft, type Draft, type Rule } from './context.ts'

export const assignReadyWork: Rule = (ctx) => {
  const free = ctx.state.peers
    .filter((peer) => peer.state === 'idle' && isLivePeer(peer))
    .sort(byOrder((peer) => String(peer.peerId)))
  if (free.length === 0) return []

  const ready = ctx.state.work
    .filter((work) => isAssignable(work.state) && !ctx.questioned.has(String(work.workId)))
    .sort(byOrder(workOrder))

  const drafts: Draft[] = []
  const taken = new Set<string>()
  for (const work of ready) {
    const peer = free.find((candidate) => !taken.has(String(candidate.peerId)) && fits(candidate, work, ctx))
    if (peer === undefined) continue
    taken.add(String(peer.peerId))
    // v1 for a Work nobody has held and a peer that carries nothing; otherwise the version after
    // the higher of the one the Work was left on and the one the peer's context already carries
    // (§12.1: versioned per peer, only up). The executor refuses a brief that is not newer than the
    // peer's, and a standing brief or an earlier Work has already moved that counter.
    const version = Math.max(work.briefVersion ?? 0, peer.briefVersion) + 1
    drafts.push(
      draft(`assign:${String(work.workId)}`, {
        kind: 'assign',
        causedBy: ctx.causedBy,
        workId: work.workId,
        peerId: peer.peerId,
        brief: briefFor({
          work,
          peer,
          version,
          contractVersions: contractVersionsFor(ctx, work),
          reason: 'assign',
        }),
      }),
    )
  }
  return drafts
}

/** The role has to match, and the peer has to be under §5.2's PR cap. */
const fits = (peer: Peer, work: Work, ctx: RuleContext): boolean => {
  if (work.role !== undefined && work.role !== peer.role) return false
  return ctx.index.openPrsOf(peer.peerId) < ctx.options.prCap
}

/**
 * The contract version this brief can truthfully name. A snapshot holds no Contract projection, so the only
 * version the PM knows is the one on the event it is answering: `contract.published` says exactly which version
 * just became live, and that is the one the dependent Work must be briefed against (§12).
 */
const contractVersionsFor = (ctx: RuleContext, work: Work): readonly ContractVersionRef[] => {
  if (work.contractId === undefined) return []
  const event = ctx.event
  if (event?.type !== 'contract.published') return []
  if (event.data.contractId !== work.contractId) return []
  return [{ contractId: event.data.contractId, version: event.data.version }]
}
