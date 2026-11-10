/**
 * The Judge (architecture §5.3): the only place a model is asked a question the
 * rules cannot decide. It is a closed set of five kinds with typed answers.
 *
 * What makes it replayable (§5.4):
 * - every call is two events, `judge.requested` then `judge.answered`, written
 *   through the append boundary, so the log holds the question, its inputs hash,
 *   the model that answered, how long it took and how many retries it needed;
 * - an answer already in the log for the same `(kind, inputsHash)` is reused, not
 *   asked again, so a replay or a repeated tick never costs a second model call
 *   and never gets a second, different answer.
 *
 * What makes it safe: peer-written text is data in a labelled block (see
 * `prompts.ts`); the answer is validated against the kind's schema and then
 * against rules the schema cannot say (a route target must be a candidate; a PR
 * with a high finding is never approved); a malformed answer gets one retry and
 * then becomes an escalation to the user, never a guess.
 */

import { createHash } from 'node:crypto'
import {
  decode,
  err,
  fleetError,
  judgeActor,
  newQuestionId,
  ok,
  systemClock,
  toFleetError,
  type Clock,
  type FleetError,
  type Result,
  type Seq,
} from '@fleet/foundation-core'
import {
  judgeAnswerFor,
  type AppendEvent,
  type EventSink,
  type Judge,
  type JudgeAnswer,
  type JudgeAnswerOf,
  type JudgeInput,
  type JudgeInputOf,
  type JudgeOptions,
  type JudgeQuestion,
  type QuestionKind,
} from '@fleet/foundation-contracts'
import { ANSWER_SCHEMAS, systemPrompt, userPrompt } from './prompts.ts'
import type { JudgeTransport } from './transport.ts'

/** How long one model call may take before it counts as a failed attempt. */
export const DEFAULT_TIMEOUT_MS = 60_000

/** One retry, then escalate: a malformed answer is a signal, not something to hammer on (§5.3). */
export const MAX_RETRIES = 1

/** The read side the Judge needs: has this exact question been answered before? */
export interface JudgeLog {
  findAnswered(
    inputsHash: string,
    kind: QuestionKind,
  ): Promise<{ readonly answer: JudgeAnswer; readonly model: string } | undefined>
}

export interface JudgeDeps {
  readonly sink: EventSink
  readonly log: JudgeLog
  readonly transport: JudgeTransport
  /** The default model; a cheap one, because most questions are small (§5.3). */
  readonly model: string
  /** Per-kind overrides, e.g. a stronger model for `review_verdict`. */
  readonly models?: Partial<Readonly<Record<QuestionKind, string>>>
  readonly timeoutMs?: number
  readonly clock?: Clock
}

export type JudgeOutcome =
  | {
      readonly status: 'answered'
      readonly answer: JudgeAnswer
      readonly model: string
      readonly retries: number
      /** True when the answer came from the log and no model was called. */
      readonly cached: boolean
    }
  | {
      /** The model could not give a valid answer: the caller escalates to the user (§5.3). */
      readonly status: 'failed'
      readonly reason: string
      readonly retries: number
    }

export interface JudgeService extends Judge {
  /**
   * Ask one question the PM decided to ask (a `request_judge` action): the
   * action carries the question id and the inputs hash the PM computed.
   * An `Err` is the fleet failing (the store refused an append); a model that
   * cannot answer is a `failed` outcome, not an error.
   */
  ask(question: JudgeQuestion): Promise<Result<JudgeOutcome, FleetError>>
}

/** Stable JSON: keys sorted at every level, so equal inputs hash equal in any order. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The hash a question is deduplicated on, for a caller (not the PM) that has none. */
export const hashInputs = (kind: QuestionKind, input: JudgeInput): string =>
  `sha256:${createHash('sha256').update(canonical({ kind, input })).digest('hex')}`

const FENCED = /```(?:json)?\s*([\s\S]*?)```/

/** The JSON object in a model reply, tolerating a code fence or a sentence around it. */
const extractJson = (text: string): string | undefined => {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return trimmed
  const fenced = FENCED.exec(trimmed)?.[1]?.trim()
  if (fenced?.startsWith('{')) return fenced
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined
}

/**
 * Rules the answer schema cannot express. Each returns a reason when the answer
 * is well-formed but not acceptable, which is retried like a malformed one.
 */
const semanticProblem = (kind: QuestionKind, input: JudgeInput, answer: JudgeAnswer): string | undefined => {
  if (answer.kind === 'route_question' && input.kind === 'route_question') {
    if (answer.peerId !== undefined && !input.candidates.some((c) => c.peerId === answer.peerId)) {
      return `peerId ${answer.peerId} is not one of the candidates`
    }
  }
  if (answer.kind === 'review_verdict' && input.kind === 'review_verdict') {
    const blocking = input.findings.some((f) => f.severity === 'high' || f.severity === 'critical')
    if (blocking && answer.verdict === 'approve') return 'a pull request with a high or critical finding is never approved'
  }
  if (answer.kind === 'thin_card' && answer.thin && answer.missing.length === 0) {
    return 'a thin card must list what is missing'
  }
  if (answer.kind === 'escalate' && answer.escalate && (answer.question === undefined || answer.question === '')) {
    return 'an escalation must state the question for the user'
  }
  return undefined
}

/** Parse and validate one reply: the answer, or why it is not acceptable. */
export const readAnswer = (
  kind: QuestionKind,
  input: JudgeInput,
  text: string,
): { readonly answer: JudgeAnswer } | { readonly problem: string } => {
  const json = extractJson(text)
  if (json === undefined) return { problem: 'the reply contains no JSON object' }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { problem: 'the reply is not valid JSON' }
  }
  const decoded = decode(judgeAnswerFor(kind), raw)
  if (!decoded.ok) {
    const first = decoded.error.issues[0]
    return { problem: `the answer does not match the ${kind} schema${first ? ` at ${first.path}: ${first.message}` : ''}` }
  }
  const problem = semanticProblem(kind, input, decoded.value as JudgeAnswer)
  return problem === undefined ? { answer: decoded.value as JudgeAnswer } : { problem }
}

export const createJudge = (deps: JudgeDeps): JudgeService => {
  const clock = deps.clock ?? systemClock
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const append = async (event: AppendEvent): Promise<Result<Seq, FleetError>> => {
    try {
      const [seq] = await deps.sink.append([event])
      return seq === undefined ? err(fleetError('store_failed', 'the store returned no sequence for a judge event')) : ok(seq)
    } catch (thrown) {
      return err(toFleetError(thrown, 'store_failed'))
    }
  }

  /** One model call within its time budget; a transport that ignores the abort is still cut off. */
  const attempt = async (kind: QuestionKind, input: JudgeInput, model: string, retryReason: string | undefined, budget: number) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(fleetError('timeout', `the judge model did not answer within ${budget} ms`))
      }, budget)
    })
    try {
      return await Promise.race([
        deps.transport.complete({
          system: systemPrompt(kind),
          prompt: userPrompt(kind, input, retryReason),
          schema: ANSWER_SCHEMAS[kind],
          model,
          signal: controller.signal,
        }),
        timedOut,
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const ask = async (question: JudgeQuestion): Promise<Result<JudgeOutcome, FleetError>> => {
    const { kind, input, inputsHash, questionId } = question
    const subject = question.workId ?? questionId
    const startedAt = clock.millis()

    const requested = await append({
      type: 'judge.requested',
      ts: clock.now(),
      subject,
      actor: 'pm',
      data: {
        questionId,
        kind,
        input,
        inputsHash,
        ...(question.workId === undefined ? {} : { workId: question.workId }),
        ...(question.askedFor === undefined ? {} : { askedFor: question.askedFor }),
      },
    } as AppendEvent)
    if (!requested.ok) return requested

    const record = async (answer: JudgeAnswer, model: string, retries: number, cached: boolean) => {
      const answered = await append({
        type: 'judge.answered',
        ts: clock.now(),
        subject,
        actor: judgeActor(model),
        causedBy: [requested.value],
        data: { questionId, kind, answer, model, durationMs: cached ? 0 : Math.max(0, clock.millis() - startedAt), retries },
      } as AppendEvent)
      if (!answered.ok) return answered
      return ok<JudgeOutcome>({ status: 'answered', answer, model, retries, cached })
    }

    // Replay: the same question was answered before, so the answer is the log's.
    let previous: Awaited<ReturnType<JudgeLog['findAnswered']>>
    try {
      previous = await deps.log.findAnswered(inputsHash, kind)
    } catch (thrown) {
      return err(toFleetError(thrown, 'store_failed'))
    }
    if (previous !== undefined) return record(previous.answer, previous.model, 0, true)

    const model = deps.models?.[kind] ?? deps.model
    let reason: string | undefined
    for (let retries = 0; retries <= MAX_RETRIES; retries += 1) {
      let text: string
      let answeredBy: string
      try {
        const reply = await attempt(kind, input, model, reason, timeoutMs)
        text = reply.text
        answeredBy = reply.model
      } catch (thrown) {
        reason = toFleetError(thrown, 'external_failed').message
        continue
      }
      const read = readAnswer(kind, input, text)
      if ('answer' in read) return record(read.answer, answeredBy, retries, false)
      reason = read.problem
    }
    return ok({ status: 'failed', reason: reason ?? 'no valid answer', retries: MAX_RETRIES })
  }

  return {
    model: deps.model,
    ask,
    async judge<K extends QuestionKind>(kind: K, input: JudgeInputOf<K>, options?: JudgeOptions): Promise<JudgeAnswerOf<K>> {
      const budget = options?.timeoutMs
      const service = budget === undefined && options?.model === undefined ? { ask } : createJudge({
        ...deps,
        ...(budget === undefined ? {} : { timeoutMs: budget }),
        ...(options?.model === undefined ? {} : { model: options.model, models: {} }),
      })
      const result = await service.ask({
        questionId: newQuestionId(),
        kind,
        input,
        inputsHash: hashInputs(kind, input as JudgeInput),
      } as JudgeQuestion)
      if (!result.ok) throw result.error
      if (result.value.status === 'failed') {
        throw fleetError('external_failed', `the judge could not answer a ${kind} question: ${result.value.reason}`)
      }
      return result.value.answer as JudgeAnswerOf<K>
    },
  }
}
