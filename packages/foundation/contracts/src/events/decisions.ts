/**
 * Decisions (architecture §5.3, §5.4, §6.1). Every PM branch is one, with the
 * typed question and answer and an `inputsHash`, so a replay can re-run the
 * rules and diff the actions — Judge answers are replayed from the log, never
 * re-asked.
 */

import { array, count, event, object, oneOf, optional, string, text } from '@fleet/foundation-core'
import { decisionId, peerId, workId } from '@fleet/foundation-core'

/** The closed list of typed questions; an LLM is consulted only through one (§5.3). */
export const questionKinds = ['same_feature', 'route_question', 'thin_card', 'review_verdict', 'escalate'] as const
export type QuestionKind = (typeof questionKinds)[number]

/** How a decision is answered: a rule, a Judge, or the user through the inbox (§6.1). */
export const decisionSources = ['rule', 'judge', 'user'] as const
export type DecisionSource = (typeof decisionSources)[number]

/**
 * Something needs an answer. When it blocks on the user it is the decision
 * inbox and a "needs your decision" notification (§6.1); a rule that decided
 * by itself uses `decision.answered` with `source: "rule"` and no request.
 */
export const decisionRequested = event(
  'decision.requested',
  object({
    decisionId: decisionId(),
    kind: string({ minLength: 1, maxLength: 60 }),
    /** One line the user reads in `fleet decide`. */
    question: text(2000),
    /** The closed set of answers the caller may pick, when it is a choice. */
    options: array(string({ minLength: 1, maxLength: 200 })),
    workId: optional(workId()),
    /** The hash of the inputs the decision was made from, for replay (§5.4). */
    inputsHash: string({ minLength: 8, maxLength: 200 }),
    /** Who could answer it: a typed Judge, or the user. */
    routedTo: optional(string({ minLength: 1, maxLength: 80 })),
  }),
)

/**
 * The answer, with the model that produced it when a Judge did, and the rule
 * that fired when code did. A malformed Judge answer that survived one retry
 * becomes `escalate` to the user (§5.3).
 */
export const decisionAnswered = event(
  'decision.answered',
  object({
    decisionId: decisionId(),
    source: oneOf(decisionSources),
    /** The chosen option, when the question was a choice. */
    option: optional(string({ minLength: 1, maxLength: 200 })),
    /** Free text, e.g. a Judge's `reason` (bounded by the answer schema). */
    text: optional(text(2000)),
    judgeModel: optional(string({ minLength: 1, maxLength: 80 })),
    /** Milliseconds the Judge call took; zero for a rule. */
    durationMs: count(),
    /** Set when this closed a decision inbox item (§6.1). */
    answeredBy: optional(peerId()),
  }),
)
