/**
 * What an eval scores: the typed fields of a Judge answer, and nothing else (§17).
 *
 * A `JudgeAnswer` is the decision plus a `why` — one line of prose the model wrote to justify itself. Prose is not
 * exactly matchable, so it is not scored here; the `judge` suite asks one question per run and asks it N times
 * (§17), and what must be stable across those runs is the decision. `briefs` and `purge-resume` are where text is a
 * rubric's business, and this slice has no rubric at all.
 *
 * The rendering is canonical — sorted keys, `undefined` dropped — because the assertion promptfoo runs is string
 * equality: two decisions are the same decision only if they render to the same string.
 */

import type { JudgeAnswer, QuestionKind, ReviewVerdict } from '@fleet/foundation-contracts'

/** The deciding fields, one per kind: the same set a case file asserts (`case.ts`). */
export interface JudgeDecision {
  readonly kind: QuestionKind
  readonly same?: boolean
  /** `null` is the route answer "no peer knows this" (§5.3), which is a decision, not a missing field. */
  readonly peerId?: string | null
  readonly thin?: boolean
  readonly verdict?: ReviewVerdict
  readonly escalate?: boolean
}

/** The scored part of an answer: which kind it is, and what it decided. */
export const decisionOf = (answer: JudgeAnswer): JudgeDecision => {
  switch (answer.kind) {
    case 'same_feature':
      return { kind: answer.kind, same: answer.same }
    case 'route_question':
      return { kind: answer.kind, peerId: answer.peerId ?? null }
    case 'thin_card':
      return { kind: answer.kind, thin: answer.thin }
    case 'review_verdict':
      return { kind: answer.kind, verdict: answer.verdict }
    case 'escalate':
      return { kind: answer.kind, escalate: answer.escalate }
  }
}

/**
 * Canonical JSON: keys sorted, `undefined` dropped, so equal decisions render equal in any order.
 *
 * A `route_question` with no `peerId` renders as `null`, because that is what it means: the routing
 * answer's documented fallback is "no candidate is placed to answer" (§5.3), and `decisionOf` already
 * gives the model's answer that value. An authored expectation and a model's answer therefore go
 * through one rule — a case that says "nobody fits" is writable as `{"kind": "route_question"}` and is
 * compared against the same string the Judge would produce.
 */
export const renderDecision = (decision: JudgeDecision): string => {
  const filled =
    decision.kind === 'route_question' && decision.peerId === undefined
      ? { ...decision, peerId: null }
      : decision
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(filled)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  )
}
