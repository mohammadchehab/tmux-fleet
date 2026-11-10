/**
 * §5.1's `proposed → ready`, which §5.2 leaves implicit: a Work becomes startable once nothing is left to decide
 * about it.
 *
 * Two ways a proposed card has nothing left to decide:
 *
 * 1. **It states its own goal.** `questionThinCards` only asks the Judge about a card whose body is shorter than
 *    `thinCardChars`; a card above that line was never questioned, so waiting for an answer waits forever.
 * 2. **The Judge said it is not thin.** The answer is a row on the question the card was asked about, so it is part
 *    of the snapshot the tick already holds (`FleetState.judge`). Any tick can therefore promote the card: the one
 *    that saw the answer, or the next heartbeat. Reading it as state rather than from the `judge.answered` event is
 *    also what keeps `dispatch` from waking on an event its own body causes the Judge to append (§6), which would
 *    be the tick re-entering itself.
 *
 * A card the Judge called thin stays `proposed`: the answer names what is missing, and asking the user for exactly
 * that is a decision question this rule does not own. It is also not silently "just try it": §5.3 asked because the
 * rule could not tell, and a verdict of thin is the answer to the question, not a flavour of yes.
 */

import type { QuestionId } from '@fleet/foundation-core'
import type { Work } from '@fleet/foundation-contracts'
import { deriveId } from '../digest.ts'
import { byOrder, workOrder } from '../state.ts'
import { draft, type Draft, type Rule, type RuleContext } from './context.ts'

/** The question a card's thin-ness is asked with, derived the same way `questionThinCards` derives it. */
const thinCardQuestion = (work: Work): QuestionId =>
  deriveId('qst', { kind: 'thin_card', workId: work.workId }) as QuestionId

/** Why this card needs no answer, or `undefined` while it still does. */
const readyReason = (card: Work, ctx: RuleContext): string | undefined => {
  if ((card.body ?? '').trim().length >= ctx.options.thinCardChars) return 'the card states its own goal'

  const answer = ctx.index.judge(thinCardQuestion(card))?.answer
  if (answer?.kind !== 'thin_card' || answer.thin) return undefined
  return `the Judge found no missing goal: ${answer.why}`.slice(0, 500)
}

export const markReadyWork: Rule = (ctx) => {
  const drafts: Draft[] = []
  for (const card of ctx.state.work.filter((row) => row.state === 'proposed').sort(byOrder(workOrder))) {
    // a card this tick already asked about is not handed out on the same breath (§5.2 `dedupe` before `assign`)
    if (ctx.questioned.has(String(card.workId))) continue
    const reason = readyReason(card, ctx)
    if (reason === undefined) continue
    drafts.push(draft(`ready:${String(card.workId)}`, { kind: 'mark_ready', causedBy: ctx.causedBy, workId: card.workId, reason }))
  }
  return drafts
}
