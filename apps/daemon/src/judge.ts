/**
 * The Judge, as `fleetd` owns it (§2, §5.3): the two things the group cannot
 * build for itself.
 *
 * 1. **The transport.** `orchestration/judge` declares `JudgeTransport` and
 *    says `apps/daemon` implements it over a provider. It is one
 *    schema-constrained call, which §4's `Provider` interface deliberately does
 *    not have, so it comes from the provider package that can do it
 *    (`@fleet/runtime-provider-claude`'s `createStructuredCompletion`) and this
 *    file hands it to the Judge. The two shapes are the same on purpose: a
 *    system prompt, a prompt, a schema, a model and a budget.
 * 2. **The log.** §5.4's replay rule is that an answer already in the log for
 *    the same `(kind, inputsHash)` is reused instead of asked again. The store
 *    keeps `judge.requested`/`judge.answered` in `events` and does not project
 *    them, so the lookup is a scan of that log, held in memory and extended
 *    from a watermark as new events arrive. A judge question is something the
 *    rules could not decide (§5.3), so the scan happens rarely and never twice
 *    for one event.
 *
 * The pair is what makes a `request_judge` action replayable: the same decision
 * replayed on a fresh store asks the model again and gets the same answer from
 * the log, not a second call (§5.4).
 */

import {
  systemClock,
  type Clock,
  type QuestionId,
  type Seq,
} from '@fleet/foundation-core'
import type { AppendEvent, EventSink, FleetEvent, JudgeAnswer, QuestionKind } from '@fleet/foundation-contracts'
import { createJudge, type JudgeLog, type JudgeService, type JudgeTransport } from '@fleet/orchestration-judge'
import type { EventStore } from '@fleet/foundation-store'

/**
 * The model a question goes to when the daemon names none. §5.3: cheap by
 * default, because most questions are small — a verdict on a card, a route to a
 * peer — and the answer is a short JSON object either way.
 */
export const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5'

/** One answered question, as the log remembers it: the answer and who gave it. */
interface LoggedAnswer {
  readonly answer: JudgeAnswer
  readonly model: string
}

/** The key an answer is found by: the kind *and* the inputs, never the question id (§5.4). */
const keyOf = (kind: QuestionKind, inputsHash: string): string => `${kind}\u0000${inputsHash}`

/**
 * `JudgeLog` over the event log (§5.3, §5.4).
 *
 * `judge.answered` does not repeat the inputs hash — the question that produced
 * it does, and the two share a `questionId` — so the scan keeps the open
 * questions by id and joins an answer to its request. A single in-flight scan
 * at a time keeps two concurrent asks from reading the same window twice.
 */
export const createJudgeLog = (store: Pick<EventStore, 'iterate'>): JudgeLog => {
  /** Questions asked, by id, until their answer arrives. */
  const asked = new Map<QuestionId, { readonly kind: QuestionKind; readonly inputsHash: string }>()
  const answers = new Map<string, LoggedAnswer>()
  /** The last seq read; the next scan starts at `watermark + 1`, so nothing is read twice. */
  let watermark: Seq = 0
  let scanning: Promise<void> | undefined

  const absorb = (event: FleetEvent): void => {
    if (event.type === 'judge.requested') {
      asked.set(event.data.questionId, { kind: event.data.kind, inputsHash: event.data.inputsHash })
      return
    }
    if (event.type !== 'judge.answered') return
    const question = asked.get(event.data.questionId)
    // An answer whose question this process never saw has no inputs hash to
    // file it under, so it is dropped: replay would key it on the wrong thing.
    if (question === undefined) return
    answers.set(keyOf(question.kind, question.inputsHash), { answer: event.data.answer, model: event.data.model })
  }

  const scan = async (): Promise<void> => {
    for await (const event of store.iterate(watermark + 1)) {
      absorb(event)
      watermark = event.seq
    }
  }

  const caughtUp = async (): Promise<void> => {
    if (scanning === undefined) {
      scanning = scan().finally(() => {
        scanning = undefined
      })
    }
    return scanning
  }

  return {
    async findAnswered(inputsHash, kind) {
      await caughtUp()
      return answers.get(keyOf(kind, inputsHash))
    },
  }
}

/** What the daemon must decide about the Judge: who answers, and how long it may take (§5.3). */
export interface DaemonJudgeDeps {
  readonly store: EventStore
  /** The one-shot structured call — a provider's, handed to the Judge. */
  readonly transport: JudgeTransport
  /** The default model; a profile may override per kind. */
  readonly model?: string
  readonly models?: Partial<Readonly<Record<QuestionKind, string>>>
  readonly timeoutMs?: number
  readonly clock?: Clock
}

/** The `JudgeService` the executor and `fleet decide` ask through (§5.3). */
export const createDaemonJudge = (deps: DaemonJudgeDeps): JudgeService => {
  const clock = deps.clock ?? systemClock
  const sink: EventSink = { append: (batch: readonly AppendEvent[]) => deps.store.append(batch) }
  return createJudge({
    sink,
    log: createJudgeLog(deps.store),
    transport: deps.transport,
    model: deps.model ?? DEFAULT_JUDGE_MODEL,
    ...(deps.models === undefined ? {} : { models: deps.models }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    clock,
  })
}
