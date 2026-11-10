/**
 * The typed questions an LLM may be asked (architecture §5.3, §5.4).
 *
 * The fleet never hands a model free text and parses the answer. Every question
 * is one of five closed kinds with a declared input and a declared answer, so a
 * malformed answer is a `SchemaError` — not a regex that silently matched
 * nothing. The PM emits a `judge.requested` action and records the answer; it
 * never calls a model itself. A replay re-reads the answers from the log, so a
 * decision is never re-asked with a different result (§5.4).
 *
 * The kinds are deliberately few. A question that does not fit one of them is a
 * missing rule in the PM, not a reason to widen the vocabulary.
 */

import { array, boolean, count, object, oneOf, optional, text, unionAs, type Infer, type Schema } from '@fleet/foundation-core'
import { peerId, questionId, workId, type PeerId, type QuestionId, type WorkId } from '@fleet/foundation-core'
import { pullRequestRef, severity } from './shapes.ts'

/** The closed list of typed questions; an LLM is consulted only through one (§5.3). */
export const questionKinds = ['same_feature', 'route_question', 'thin_card', 'review_verdict', 'escalate'] as const
export type QuestionKind = (typeof questionKinds)[number]
export const questionKind = (): Schema<QuestionKind> => oneOf(questionKinds)

/** A model's one-line justification. Required: an answer nobody can audit is not remembered. */
const why = (): Schema<string> => text(1000)

// ------------------------------------------------------------------- inputs

/** What the dedupe rule shows the Judge when it asks whether two cards are one feature (§5.2). */
const workSummary = () =>
  object({
    title: text(300),
    body: text(4000),
    files: array(text(500)),
  })

export const sameFeatureInput = object({
  kind: oneOf(['same_feature'] as const),
  a: workSummary(),
  b: workSummary(),
})

/** A peer in the routing decision: the id, and what it is for. */
const candidate = () => object({ peerId: peerId(), role: text(80) })

export const routeQuestionInput = object({
  kind: oneOf(['route_question'] as const),
  question: text(4000),
  candidates: array(candidate()),
})

export const thinCardInput = object({
  kind: oneOf(['thin_card'] as const),
  title: text(300),
  goal: text(4000),
  acceptance: array(text(500)),
})

/** A review finding as the gate sees it, before it decides whether to trust it (§10). */
const reviewFinding = () => object({ severity: severity(), message: text(1000) })

export const reviewVerdictInput = object({
  kind: oneOf(['review_verdict'] as const),
  pr: pullRequestRef(),
  title: text(300),
  findings: array(reviewFinding()),
  filesChanged: count(),
})

export const escalateInput = object({
  kind: oneOf(['escalate'] as const),
  situation: text(4000),
  options: array(text(200)),
})

// ------------------------------------------------------------------ answers

export const sameFeatureAnswer = object({
  kind: oneOf(['same_feature'] as const),
  same: boolean(),
  why: why(),
})

export const routeQuestionAnswer = object({
  kind: oneOf(['route_question'] as const),
  /** Absent means "no peer knows this"; the caller escalates to the user (§5.3). */
  peerId: optional(peerId()),
  why: why(),
})

export const thinCardAnswer = object({
  kind: oneOf(['thin_card'] as const),
  thin: boolean(),
  /** What a card is missing, so the PM can ask for exactly that instead of re-asking. */
  missing: array(text(300)),
  why: why(),
})

export const reviewVerdicts = ['approve', 'changes_requested', 'escalate'] as const
export type ReviewVerdict = (typeof reviewVerdicts)[number]

export const reviewVerdictAnswer = object({
  kind: oneOf(['review_verdict'] as const),
  verdict: oneOf(reviewVerdicts),
  why: why(),
})

export const escalateAnswer = object({
  kind: oneOf(['escalate'] as const),
  escalate: boolean(),
  /** The question to put to the user, when the answer is yes. */
  question: optional(text(2000)),
  options: optional(array(text(200))),
  why: why(),
})

// ------------------------------------------------------------- the mapping

/**
 * Kind → its input and answer. The single place the two closed sets are tied
 * together: adding a kind here without a schema above does not compile, and
 * adding a schema without a kind is unused.
 */
export interface JudgeQuestions {
  readonly same_feature: { readonly input: typeof sameFeatureInput; readonly answer: typeof sameFeatureAnswer }
  readonly route_question: { readonly input: typeof routeQuestionInput; readonly answer: typeof routeQuestionAnswer }
  readonly thin_card: { readonly input: typeof thinCardInput; readonly answer: typeof thinCardAnswer }
  readonly review_verdict: { readonly input: typeof reviewVerdictInput; readonly answer: typeof reviewVerdictAnswer }
  readonly escalate: { readonly input: typeof escalateInput; readonly answer: typeof escalateAnswer }
}

export type JudgeInputOf<K extends QuestionKind> = Infer<JudgeQuestions[K]['input']>
export type JudgeAnswerOf<K extends QuestionKind> = Infer<JudgeQuestions[K]['answer']>

export type JudgeInput = JudgeInputOf<QuestionKind>
export type JudgeAnswer = JudgeAnswerOf<QuestionKind>

export const judgeInput = (): Schema<JudgeInput> =>
  unionAs<JudgeInput>()([
    sameFeatureInput,
    routeQuestionInput,
    thinCardInput,
    reviewVerdictInput,
    escalateInput,
  ])

export const judgeAnswer = (): Schema<JudgeAnswer> =>
  unionAs<JudgeAnswer>()([
    sameFeatureAnswer,
    routeQuestionAnswer,
    thinCardAnswer,
    reviewVerdictAnswer,
    escalateAnswer,
  ])

const answerSchemas: { readonly [K in QuestionKind]: JudgeQuestions[K]['answer'] } = {
  same_feature: sameFeatureAnswer,
  route_question: routeQuestionAnswer,
  thin_card: thinCardAnswer,
  review_verdict: reviewVerdictAnswer,
  escalate: escalateAnswer,
}

/**
 * The answer schema for one kind; what a caller validates a reply against. The
 * kind is known before the reply arrives, so an unvalidated answer never
 * reaches the PM.
 */
export const judgeAnswerFor = <K extends QuestionKind>(kind: K): Schema<JudgeAnswerOf<K>> =>
  answerSchemas[kind] as unknown as Schema<JudgeAnswerOf<K>>

// ------------------------------------------------------------------- the port

/**
 * What the PM depends on when a rule cannot decide (§5.3). Implemented by
 * `@fleet/integrations-judge`; faked in every test, so the PM is deterministic
 * without a model and a replay reads the log instead of calling out (§5.4).
 *
 * `judge` is generic over the kind, so a caller cannot ask for a
 * `review_verdict` and receive a `same_feature` answer at the type level; the
 * runtime check is `judgeAnswerFor(kind)`.
 */
export interface JudgeOptions {
  /** Overrides the port's default model for one call. */
  readonly model?: string
  readonly timeoutMs?: number
}

export interface Judge {
  /** The model this port asks; recorded as actor `judge:<model>` (§3). */
  readonly model: string
  judge<K extends QuestionKind>(kind: K, input: JudgeInputOf<K>, options?: JudgeOptions): Promise<JudgeAnswerOf<K>>
}

/** What a Judge is asked, before the PM turns it into a `judge.requested` event. */
export interface JudgeQuestion<K extends QuestionKind = QuestionKind> {
  readonly questionId: QuestionId
  readonly kind: K
  readonly input: JudgeInputOf<K>
  /** The hash of the inputs the question was formed from, for replay (§5.4). */
  readonly inputsHash: string
  readonly workId?: WorkId
  /** The peer whose work raised it, when one did. */
  readonly askedFor?: PeerId
}
