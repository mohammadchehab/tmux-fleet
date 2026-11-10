/**
 * §6.1 — how the PM reaches Mohammad: a `Decision` row in the inbox, not a notification.
 *
 * The PM never notifies. It appends `decision.requested` (as an action) and the notification projection turns that
 * into a banner, so channels stay out of the rules (§6.1). Three things block on the user, and each is a rule here:
 *
 * - **An approval the gate cannot get** (§10): checks are green, the review is still `pending`, and no peer
 *   running the reviewer role is in the fleet. §10 says the gate asks rather than stalling silently.
 * - **An escalated Judge question** (§5.3): a malformed answer that survived one retry becomes `escalate`. The
 *   answer is an event, so the tick that sees `judge.answered` turns it into the user's question.
 * - **A role nobody holds** (§5.2 `assign`): a ready Work for a role the squad does not have can never be assigned,
 *   and silence about that is how a card rots.
 *
 * Each question's `decisionId` is derived from what it asks about, so the inbox has one row per question: an
 * answered row is looked up and the question is not asked again, and a new head SHA is a new question (§5.4).
 */

import { isAssignable } from '@fleet/foundation-contracts'
import type { DecisionId } from '@fleet/foundation-core'
import type { PullRequest } from '@fleet/foundation-contracts'
import { deriveId, shortHash } from '../digest.ts'
import { byOrder, isLivePeer, prKey, refOf, workOrder } from '../state.ts'
import { approvalDecisionId, approvalInputsHash, prsInOrder } from './gate.ts'
import { draft, type Draft, type Rule, type RuleContext } from './context.ts'

export const requestDecisions: Rule = (ctx) => [...judgeEscalations(ctx), ...approvalGaps(ctx), ...unheldRoles(ctx)]

/** §5.3: a Judge answer that escalated becomes the user's decision, carrying the question the Judge formed. */
const judgeEscalations = (ctx: RuleContext): readonly Draft[] => {
  const event = ctx.event
  if (event?.type !== 'judge.answered') return []
  const { questionId, answer } = event.data
  if (answer.kind !== 'escalate' || !answer.escalate) return []

  const decisionId = deriveId('dec', { kind: 'escalate', questionId }) as DecisionId
  if (ctx.index.decision(decisionId) !== undefined) return []

  return [
    draft(`decision:${decisionId}`, {
      kind: 'request_decision',
      causedBy: ctx.causedBy,
      decisionId,
      decisionKind: 'escalate',
      question: answer.question ?? `A Judge question could not be answered: ${answer.why}`,
      options: answer.options ?? [],
      inputsHash: shortHash({ questionId, answer }),
    }),
  ]
}

/** §10: green, unreviewed, and nobody in the fleet may review it. */
const approvalGaps = (ctx: RuleContext): readonly Draft[] => {
  if (ctx.index.peersWithRole(ctx.options.reviewerRole).some(isLivePeer)) return []

  const drafts: Draft[] = []
  for (const pr of prsInOrder(ctx)) {
    if (pr.merged || pr.checks !== 'passing' || pr.review !== 'pending') continue
    const decisionId = approvalDecisionId(refOf(pr), pr.headSha)
    // asked already: an open row is the same question, an answered one is this question's answer
    if (ctx.index.decision(decisionId) !== undefined) continue

    const work = ctx.index.workOfPr(pr)
    drafts.push(
      draft(`decision:${decisionId}`, {
        kind: 'request_decision',
        causedBy: ctx.causedBy,
        decisionId,
        decisionKind: 'approval',
        question: approvalQuestion(pr, ctx),
        options: ['merge', 'hold'],
        ...(work === undefined ? {} : { workId: work.workId }),
        inputsHash: approvalInputsHash(pr),
      }),
    )
  }
  return drafts
}

const approvalQuestion = (pr: PullRequest, ctx: RuleContext): string =>
  `${prKey(refOf(pr))} is green on ${pr.headSha.slice(0, 7)} and review is still pending. ` +
  `No peer is running the "${ctx.options.reviewerRole}" role, so §10's gate needs your call: merge it, or hold it.`

/** §5.2 `assign`: a ready Work for a role no live peer holds cannot be assigned by any rule, so it is asked about. */
const unheldRoles = (ctx: RuleContext): readonly Draft[] => {
  const live = ctx.state.peers.filter(isLivePeer)
  const drafts: Draft[] = []

  for (const work of ctx.state.work.filter((row) => isAssignable(row.state)).sort(byOrder(workOrder))) {
    if (work.role === undefined) continue
    if (live.some((peer) => peer.role === work.role)) continue

    const decisionId = deriveId('dec', { kind: 'no_peer', role: work.role }) as DecisionId
    if (ctx.index.decision(decisionId) !== undefined) continue

    drafts.push(
      draft(`decision:${decisionId}`, {
        kind: 'request_decision',
        causedBy: ctx.causedBy,
        decisionId,
        decisionKind: 'no_peer',
        question:
          `No peer in the squad holds the role "${work.role}", so ${String(work.workId)} ("${work.title}") ` +
          `cannot be assigned. Add a ${work.role} to the profile, or cancel the Work.`,
        options: [],
        workId: work.workId,
        inputsHash: shortHash({ kind: 'no_peer', role: work.role, workId: work.workId }),
      }),
    )
  }
  return drafts
}
