/**
 * §5.2 `unblock`: a peer in `waiting_input` is stuck, and the tick's job is to get it moving again.
 *
 * The trigger is the peer's state, but the *routing* is the Work's: `Work.blockedOn` says who can
 * answer, and `blockReasons` is a closed list for exactly this reason (§5.1). The PM does not read
 * the peer's prose to guess — that would be a model call, and §5.2 asks a rule.
 *
 * Three routes, in the order the log can satisfy them:
 *
 * 1. **The `Decision` log already answered it** (§6.1). The user answered a `Decision` tied to this
 *    Work while the peer was still stuck; the answer is an event, so the same tick that sees the peer
 *    waiting delivers it. This is why the log is checked first: it costs the user nothing.
 * 2. **A peer can answer it** — `peer` or `contract`. The reviewer role is who §12 makes publish
 *    contracts and §10 makes review, so the block is routed there as a message. No live peer in that
 *    role means nobody can answer it, and silence about that is how a card rots, so it becomes (3).
 * 3. **Only the user can** — `user`, `external`, or a `peer`/`contract` block with no one to route to.
 *    A `Decision` row in the inbox, one per Work (`blockedDecisionId`), so a re-tick does not re-ask.
 *
 * A `blockedOn` of `undefined` routes to the user: nothing is known to be able to unblock it, and
 * asking is recoverable where guessing is not.
 */

import type { DecisionId } from '@fleet/foundation-core'
import type { Decision, Peer, Work } from '@fleet/foundation-contracts'
import { deriveId, shortHash } from '../digest.ts'
import { byOrder, isLivePeer, workOrder } from '../state.ts'
import { draft, type Draft, type Rule, type RuleContext } from './context.ts'

/** One inbox row per blocked Work, whichever route it took: the same question is not two questions. */
export const blockedDecisionId = (work: Work): DecisionId =>
  deriveId('dec', { kind: 'blocked', workId: work.workId }) as DecisionId

export const unblockWaitingPeers: Rule = (ctx) => {
  const waiting = ctx.state.peers
    .filter((peer) => peer.state === 'waiting_input' && isLivePeer(peer))
    .sort(byOrder((peer) => String(peer.peerId)))

  const drafts: Draft[] = []
  for (const peer of waiting) {
    const work = blockedWorkOf(peer, ctx)
    // a peer may be waiting on something that is not a blocked Work — a question mid-turn is the
    // provider's business, not the PM's, and there is no field to route it by
    if (work === undefined) continue

    const answered = answeredDecisionFor(work, ctx)
    const routed = answered === undefined ? routeBlock(peer, work, ctx) : deliverAnswer(peer, work, answered, ctx)
    if (routed !== undefined) drafts.push(routed)
  }
  return drafts
}

/**
 * Has this peer already been told this? A tick runs on the heartbeat as well as on events, and a peer
 * stays `waiting_input` until something lands, so without this the same instruction is resent every
 * tick. The `Message` projection is the log of what was said to whom, and each body carries the id of
 * the thing it is about, so the marker is in the text by construction.
 */
const alreadyTold = (to: Peer['peerId'], marker: string, ctx: RuleContext): boolean =>
  ctx.state.messages.some((row) => row.to === to && row.body.includes(marker))

/** The Work a waiting peer is blocked on: its own, in creation order, when it has more than one. */
const blockedWorkOf = (peer: Peer, ctx: RuleContext): Work | undefined =>
  ctx.state.work
    .filter((work) => work.assignee === peer.peerId && work.state === 'blocked')
    .sort(byOrder(workOrder))[0]

/** The most recent answered `Decision` about this Work — the user's answer, already in the log (§6.1). */
const answeredDecisionFor = (work: Work, ctx: RuleContext): Decision | undefined =>
  ctx.state.decisions
    .filter((row) => row.workId === work.workId && row.state === 'answered' && answerText(row) !== '')
    .sort(byOrder((row) => `${row.answeredAt ?? ''}|${String(row.decisionId)}`))
    .at(-1)

const answerText = (row: Decision): string => (row.text ?? row.option ?? '').trim()

/** Route 1: the answer is already in the log, so the peer gets it and nobody is asked anything. */
const deliverAnswer = (
  peer: Peer,
  work: Work,
  answered: Decision,
  ctx: RuleContext,
): Draft | undefined => {
  if (alreadyTold(peer.peerId, String(answered.decisionId), ctx)) return undefined

  const body = [
    `Answer for Work ${String(work.workId)}: ${work.title}`,
    '',
    answerText(answered),
    '',
    `This answers ${String(answered.decisionId)} ("${answered.question}"). Carry on against brief version ${peer.briefVersion}.`,
  ].join('\n')

  return draft(`unblock:${String(work.workId)}`, {
    kind: 'send_message',
    causedBy: ctx.causedBy,
    to: peer.peerId,
    messageKind: 'answer',
    body,
    briefVersion: peer.briefVersion,
  })
}

const routeBlock = (peer: Peer, work: Work, ctx: RuleContext): Draft | undefined => {
  if (work.blockedOn === 'peer' || work.blockedOn === 'contract') {
    const architect = ctx.index
      .peersWithRole(ctx.options.reviewerRole)
      .filter(isLivePeer)
      .sort(byOrder((row) => String(row.peerId)))[0]
    if (architect !== undefined) return askArchitect(peer, work, architect, ctx)
  }
  return askUser(peer, work, ctx)
}

/** Route 2: `peer`/`contract` blocks are the reviewer role's to clear (§10, §12). */
const askArchitect = (peer: Peer, work: Work, architect: Peer, ctx: RuleContext): Draft | undefined => {
  if (alreadyTold(architect.peerId, String(work.workId), ctx)) return undefined

  const body = [
    `${String(peer.peerId)} (${peer.role}) is waiting on Work ${String(work.workId)}: ${work.title}`,
    '',
    `Blocked on ${String(work.blockedOn)}: ${work.blockedReason ?? 'no reason given'}`,
    '',
    `You hold the "${ctx.options.reviewerRole}" role, so answering it is yours. Reply to ${String(peer.peerId)}; ` +
      `it is on brief version ${peer.briefVersion}.`,
  ].join('\n')

  return draft(`unblock:${String(work.workId)}`, {
    kind: 'send_message',
    causedBy: ctx.causedBy,
    to: architect.peerId,
    messageKind: 'info',
    body,
    briefVersion: architect.briefVersion,
  })
}

/** Route 3: the decision inbox — the only route §6.1 lets the PM reach the user by. */
const askUser = (peer: Peer, work: Work, ctx: RuleContext): Draft | undefined => {
  const decisionId = blockedDecisionId(work)
  if (ctx.index.decision(decisionId) !== undefined) return undefined

  const blockedOn = String(work.blockedOn ?? 'unknown')
  const routeable = work.blockedOn === 'peer' || work.blockedOn === 'contract'
  const who = routeable
    ? `No live peer holds the "${ctx.options.reviewerRole}" role, so nobody can clear it`
    : `Nothing in the fleet can unblock a ${blockedOn} blocker`

  return draft(`unblock:${String(work.workId)}`, {
    kind: 'request_decision',
    causedBy: ctx.causedBy,
    decisionId,
    decisionKind: 'blocked',
    question:
      `${String(peer.peerId)} (${peer.role}) is waiting on Work ${String(work.workId)}: ${work.title}. ` +
      `Blocked on ${blockedOn}: ${work.blockedReason ?? 'no reason given'}. ${who} — decide it, or cancel the Work.`,
    options: [],
    workId: work.workId,
    inputsHash: shortHash({ kind: 'blocked', workId: work.workId, blockedOn, reason: work.blockedReason ?? '' }),
  })
}
