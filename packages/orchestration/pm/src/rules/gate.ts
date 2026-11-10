/**
 * §10, the PR gate, as the PM states it: a `merge` is a request, never a merge, and only a request the gate's own
 * preconditions allow.
 *
 * The three preconditions of §10 are all refusals here rather than checks in the executor:
 *
 * 1. **checks green on the current head SHA** — a PR whose checks are pending or failing is not merged, and the
 *    `headSha` the PM names is the one it saw go green, so the gate can refuse a head that moved underneath it.
 * 2. **the required review is present** — `review: 'approved'`, or the user's `merge` answer to the approval
 *    decision this same tick would have asked (§6.1). With no reviewer role running the gate asks, and only the
 *    user's answer lets it through.
 * 3. **no unmerged stack parent** — and if the parent *has* merged, the dependent is retargeted first, in an
 *    earlier rule of the same tick, so it is never merged while it still sits on the parent's head (§10).
 *
 * There is no `deleteBranch` anywhere: the merge action deliberately cannot say it, so the #102 loss is not
 * expressible (#10).
 */

import type { DecisionId, Sha } from '@fleet/foundation-core'
import type { PullRequest, PullRequestRef } from '@fleet/foundation-contracts'
import { deriveId, shortHash } from '../digest.ts'
import { byOrder, isLivePeer, prKey, prOrder, refOf } from '../state.ts'
import { draft, type Draft, type Rule, type RuleContext } from './context.ts'

/**
 * The approval question for one PR at one head SHA, derived so the same question is the same row: re-asking is a
 * no-op, and a new head SHA is a genuinely new question (§5.4, §6.1).
 */
export const approvalDecisionId = (pr: PullRequestRef, headSha: Sha): DecisionId =>
  deriveId('dec', { kind: 'approval', pr: prKey(pr), headSha }) as DecisionId

/** §10: a stack parent merged, so its dependents move onto the parent's base before anything is merged. */
export const retargetDependents: Rule = (ctx) => {
  const drafts: Draft[] = []
  for (const pr of ctx.index.prs) {
    if (pr.merged || pr.stackParent === undefined) continue
    const parent = ctx.index.pr(pr.stackParent)
    if (parent === undefined || !parent.merged) continue
    // already retargeted: the dependent's base is no longer the branch its parent merged from
    if (pr.base !== parent.head) continue
    drafts.push(
      draft(`retarget:${prKey(refOf(pr))}`, {
        kind: 'retarget',
        causedBy: ctx.causedBy,
        pr: refOf(pr),
        toBase: parent.base,
      }),
    )
  }
  return drafts
}

/** §5.2 `merge`: ask the gate to merge what it is allowed to merge, at the SHA the PM saw green. */
export const mergeGreenPrs: Rule = (ctx) => {
  const drafts: Draft[] = []
  for (const pr of ctx.index.prs) {
    if (mergeBlocker(pr, ctx) !== undefined) continue
    drafts.push(
      draft(`merge:${prKey(refOf(pr))}`, {
        kind: 'merge',
        causedBy: ctx.causedBy,
        pr: refOf(pr),
        headSha: pr.headSha,
        method: ctx.options.mergeMethod,
      }),
    )
  }
  return drafts
}

/**
 * Why the gate may not merge this PR, or `undefined` when it may. Exported so a test can name the reason instead
 * of proving a negative from the absence of an action.
 */
export const mergeBlocker = (pr: PullRequest, ctx: RuleContext): string | undefined => {
  if (pr.merged) return 'already merged'
  if (pr.checks !== 'passing') return `checks are ${pr.checks}`
  if (pr.review !== 'approved' && !approvedByUser(pr, ctx)) return `review is ${pr.review}`

  if (pr.stackParent !== undefined) {
    const parent = ctx.index.pr(pr.stackParent)
    if (parent !== undefined && !parent.merged) return `stack parent ${prKey(pr.stackParent)} is unmerged`
    // the parent merged but the dependent still sits on its head: §10 says retarget first
    if (parent !== undefined && pr.base === parent.head) return 'dependent must be retargeted first'
  }
  return undefined
}

/**
 * §10's "with no reviewer role running the gate asks the user": when it did, the user's `merge` answer is the
 * review. The answer is a `Decision` in the snapshot — `state: answered`, the option the user picked — so nothing
 * outside the log has to be remembered.
 */
const approvedByUser = (pr: PullRequest, ctx: RuleContext): boolean => {
  if (ctx.index.peersWithRole(ctx.options.reviewerRole).some(isLivePeer)) return false
  const decision = ctx.index.decision(approvalDecisionId(refOf(pr), pr.headSha))
  return decision !== undefined && decision.state === 'answered' && decision.option === 'merge'
}

/** The `inputsHash` an approval decision records: what the user was actually looking at (§5.4). */
export const approvalInputsHash = (pr: PullRequest): string =>
  shortHash({ pr: prKey(refOf(pr)), headSha: pr.headSha, checks: pr.checks })

/** The PRs in the order the gate walks them, for a rule that needs the list itself. */
export const prsInOrder = (ctx: RuleContext): readonly PullRequest[] =>
  [...ctx.state.pullRequests].sort(byOrder(prOrder))
