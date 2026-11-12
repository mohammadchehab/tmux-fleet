/**
 * The question rules: §5.2's `dedupe` and §5.3's `thin_card`, both of which are "a rule cannot decide, so ask the
 * Judge" — never "the PM calls a model".
 *
 * The PM emits `request_judge`, which is an action with the same fields as `judge.requested`; whoever owns the
 * Judge port runs it and appends the answer (§5.3). A replay then reads both from the log and never asks again
 * (§5.4). Both questions here are derived from the Work they are about, so a second tick that notices the same
 * thing names the same `questionId` — a repeat is the executor's to collapse, not a second question.
 *
 * Similarity is a Jaccard score over the significant words of the card's title and body. It is deliberately dull:
 * a rule that cannot explain why it asked is a rule whose diff a reviewer has to trust, and the Judge exists
 * precisely because "are these two the same feature?" is not a lexical question. The threshold is policy
 * (`PmOptions.duplicateThreshold`), so a noisy corpus is tuned, not re-worded.
 */

import { isAssignable, isOpen } from '@fleet/foundation-contracts'
import type { JudgeInputOf } from '@fleet/foundation-contracts'
import type { QuestionId } from '@fleet/foundation-core'
import type { Work } from '@fleet/foundation-contracts'
import { deriveId, shortHash } from '../digest.ts'
import { byOrder, workOrder } from '../state.ts'
import { draft, type Draft, type Rule } from './context.ts'

/** Words that carry no intent; every card has them, so they would make every pair look alike. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'than', 'when', 'what', 'which', 'while',
  'must', 'should', 'would', 'could', 'have', 'has', 'are', 'was', 'were', 'not', 'but', 'its', 'it', 'our',
  'add', 'new', 'make', 'use', 'used', 'using', 'one', 'all', 'any', 'can', 'will',
])

const words = (card: Work): Set<string> =>
  new Set(
    `${card.title} ${card.body ?? ''}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  )

/** How much two cards' words overlap, 0–1. */
export const similarity = (a: Work, b: Work): number => {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}

const summaryOf = (card: Work): JudgeInputOf<'same_feature'>['a'] => ({
  title: card.title,
  body: (card.body ?? '').slice(0, 4000),
  // files are not in the Work projection; the Judge is asked about intent, not about the diff
  files: [],
})

/**
 * §5.2 `dedupe`, before `assign`: is a ready Work the same feature as something already open? If the words say it
 * might be, ask — and mark *both* cards questioned, because the question is whether they are one feature, so
 * neither should be handed out until the answer arrives.
 */
export const questionDuplicates: Rule = (ctx) => {
  const openCards = ctx.state.work.filter((card) => isOpen(card.state)).sort(byOrder(workOrder))
  const drafts: Draft[] = []
  const earlier: Work[] = []

  for (const card of openCards) {
    // the twin is always the older card, so a pair is asked about once and the question has a stable direction
    const twin = earlier.find((other) => similarity(card, other) >= ctx.options.duplicateThreshold)
    earlier.push(card)
    if (twin === undefined || !isAssignable(card.state)) continue

    const input: JudgeInputOf<'same_feature'> = { kind: 'same_feature', a: summaryOf(card), b: summaryOf(twin) }
    ctx.questioned.add(String(card.workId))
    ctx.questioned.add(String(twin.workId))
    drafts.push(
      draft(`question:${String(card.workId)}`, {
        kind: 'request_judge',
        causedBy: ctx.causedBy,
        questionId: deriveId('qst', { kind: 'same_feature', a: card.workId, b: twin.workId }) as QuestionId,
        question: 'same_feature',
        input,
        inputsHash: shortHash(input),
        workId: card.workId,
        askedFor: card.assignee,
      }),
    )
  }
  return drafts
}

/**
 * §5.3 `thin_card`: a proposed Work whose description is too short to have a goal is asked about before anyone is
 * briefed on it. The answer names what is missing, so the PM can ask for exactly that rather than asking again.
 */
export const questionThinCards: Rule = (ctx) => {
  const drafts: Draft[] = []

  for (const card of ctx.state.work.filter((row) => row.state === 'proposed').sort(byOrder(workOrder))) {
    const goal = (card.body ?? '').trim()
    if (goal.length >= ctx.options.thinCardChars) continue

    const input: JudgeInputOf<'thin_card'> = {
      kind: 'thin_card',
      title: card.title,
      goal: goal === '' ? card.title : goal,
      acceptance: [],
    }
    const questionId = deriveId('qst', { kind: 'thin_card', workId: card.workId }) as QuestionId
    const inputsHash = shortHash(input)
    // Already answered for these exact inputs: asking again only appends another requested/answered pair, and
    // `dispatch` wakes on that pair, so a thin card would be asked about on every tick. An edited card hashes
    // differently and is asked afresh. The verdict itself is `markReadyWork`'s to read; this rule just stays quiet.
    const prior = ctx.index.judge(questionId)
    if (prior?.answer !== undefined && prior.inputsHash === inputsHash) continue

    drafts.push(
      draft(`question:${String(card.workId)}`, {
        kind: 'request_judge',
        causedBy: ctx.causedBy,
        questionId,
        question: 'thin_card',
        input,
        inputsHash,
        workId: card.workId,
      }),
    )
  }
  return drafts
}
