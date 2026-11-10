/**
 * §5.2 `stale` / §12 — a contract moved on, so the brief a peer is working from names a version that is no longer
 * the contract.
 *
 * The PM sees staleness on the event, not by comparing projections: a `contract.published` names the contract and
 * the version that just became live, and the Work that depend on it are the ones whose `contractId` is that
 * contract (or that list it in `dependsOn`). That is enough to write the replacement brief truthfully — the old
 * version is on the Work (`briefVersion`), the new one is on the event — without a Contract projection in the
 * snapshot.
 *
 * The old brief is never edited: the action names it as `supersededBriefId` and hands over a new, complete one
 * (§12's "supersede, never edit"), so a peer's context can always be traced to the exact text it was given.
 */

import { isOpen } from '@fleet/foundation-contracts'
import { briefFor } from '../brief.ts'
import { byOrder, workOrder } from '../state.ts'
import { draft, type Draft, type Rule } from './context.ts'

export const supersedeStaleBriefs: Rule = (ctx) => {
  const event = ctx.event
  if (event?.type !== 'contract.published') return []
  const { contractId, version, workId: author } = event.data

  const drafts: Draft[] = []
  for (const work of ctx.state.work.filter((row) => isOpen(row.state)).sort(byOrder(workOrder))) {
    // nobody is holding a brief for this Work yet, so there is nothing stale
    if (work.assignee === undefined || work.briefId === undefined || work.briefVersion === undefined) continue
    // the Work that wrote the contract is the one that should be re-briefed by its own change, not by this event
    if (author !== undefined && author === work.workId) continue
    if (work.contractId !== contractId && !work.dependsOn.includes(String(contractId))) continue

    const peer = ctx.index.peer(work.assignee)
    if (peer === undefined) continue

    const nextVersion = work.briefVersion + 1
    drafts.push(
      draft(`supersede:${String(work.workId)}`, {
        kind: 'supersede_brief',
        causedBy: ctx.causedBy,
        workId: work.workId,
        peerId: peer.peerId,
        supersededBriefId: work.briefId,
        supersededVersion: work.briefVersion,
        brief: briefFor({
          work,
          peer,
          version: nextVersion,
          contractVersions: [{ contractId, version }],
          reason: 'supersede',
        }),
        reason: `contract ${String(contractId)} published v${version}`,
      }),
    )
  }
  return drafts
}
