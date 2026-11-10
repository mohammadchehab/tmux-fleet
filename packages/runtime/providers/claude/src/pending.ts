/**
 * The one place a session blocks on a person (§4, §6.1).
 *
 * Two SDK situations arrive on the same control channel — `canUseTool` — and
 * both block the turn until the host answers, with no deadline:
 *
 * - `AskUserQuestion`, which is the peer asking its supervisor something;
 * - every other tool that the permission mode made ask, which is an approval.
 *
 * The adapter mints an id for each, keeps them in one map, and hands the caller
 * a promise it resolves through `answer()` / `respond()`. The ids are minted
 * here rather than read off the SDK because the SDK's control-request id is an
 * implementation detail on the wire; when the §4 contract change lands these
 * ids travel on the events and the supervisor answers by id. Until then
 * `answer()` and `respond()` accept the oldest open item of that kind, which is
 * all the current `question.asked` projection can support.
 *
 * An unanswered item is abandoned, never left dangling: a turn that is
 * interrupted or a session that stops resolves it as `deny` and reports
 * `question.abandoned`, so no promise outlives the session that raised it (§8).
 */

import { randomUUID } from 'node:crypto'

import { fleetError, type Timestamp, type TurnId } from '@fleet/foundation-core'

import type { AskedQuestion } from './events.ts'

/** `qst_<16 hex>`, the same opaque shape `foundation/core` mints (§3). */
export type QuestionId = string
/** `apr_<16 hex>`. */
export type RequestId = string

export interface OpenQuestion {
  readonly questionId: QuestionId
  readonly turnId: TurnId
  readonly askedAt: Timestamp
  readonly questions: readonly AskedQuestion[]
}

export interface OpenApproval {
  readonly requestId: RequestId
  readonly turnId: TurnId
  readonly askedAt: Timestamp
  readonly tool: string
  readonly summary?: string
}

/** What a person decided about a blocked tool call. */
export type ApprovalDecision = 'allow' | 'deny'

export type AbandonReason = 'interrupted' | 'ended'

interface Waiter<T> {
  settle(value: T): void
  abandon(reason: AbandonReason): void
}

const mint = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`

export class PendingRequests {
  readonly #questions = new Map<QuestionId, { open: OpenQuestion; waiter: Waiter<string> }>()
  readonly #approvals = new Map<RequestId, { open: OpenApproval; waiter: Waiter<ApprovalDecision> }>()
  readonly #now: () => Timestamp

  constructor(now: () => Timestamp) {
    this.#now = now
  }

  /** Register a question and hand back the promise the turn is blocked on. */
  ask(
    turnId: TurnId,
    questions: readonly AskedQuestion[],
  ): { open: OpenQuestion; wait: Promise<string> } {
    const open: OpenQuestion = Object.freeze({
      questionId: mint('qst'),
      turnId,
      askedAt: this.#now(),
      questions: Object.freeze(questions.map(freezeQuestion)),
    })
    const wait = new Promise<string>((resolve) => {
      this.#questions.set(open.questionId, {
        open,
        waiter: { settle: (answer) => resolve(answer), abandon: () => resolve('') },
      })
    })
    return { open, wait }
  }

  /** Register a tool approval and hand back the promise the tool is blocked on. */
  askApproval(
    turnId: TurnId,
    tool: string,
    summary: string | undefined,
  ): { open: OpenApproval; wait: Promise<ApprovalDecision> } {
    const open: OpenApproval = Object.freeze({
      requestId: mint('apr'),
      turnId,
      askedAt: this.#now(),
      tool,
      ...(summary === undefined ? {} : { summary }),
    })
    const wait = new Promise<ApprovalDecision>((resolve) => {
      this.#approvals.set(open.requestId, {
        open,
        waiter: { settle: (decision) => resolve(decision), abandon: () => resolve('deny') },
      })
    })
    return { open, wait }
  }

  /**
   * Answer a question. Without an id this answers the oldest open one, which is
   * what a supervisor can do while `question.asked` has no id on it.
   *
   * @throws FleetError('not_found') when nothing is open — a stale answer, not a crash.
   */
  answer(text: string, questionId?: QuestionId): OpenQuestion {
    const entry =
      questionId === undefined ? this.#oldest(this.#questions) : this.#questions.get(questionId)
    if (entry === undefined) {
      throw fleetError('not_found', `no open question ${questionId ?? '(oldest)'} to answer`, {
        details: { open: [...this.#questions.keys()] },
      })
    }
    this.#questions.delete(entry.open.questionId)
    entry.waiter.settle(text)
    return entry.open
  }

  /**
   * Allow or deny a blocked tool call.
   *
   * @throws FleetError('not_found') when nothing is open.
   */
  respond(decision: ApprovalDecision, requestId?: RequestId): OpenApproval {
    const entry = requestId === undefined ? this.#oldest(this.#approvals) : this.#approvals.get(requestId)
    if (entry === undefined) {
      throw fleetError('not_found', `no open approval ${requestId ?? '(oldest)'} to answer`, {
        details: { open: [...this.#approvals.keys()] },
      })
    }
    this.#approvals.delete(entry.open.requestId)
    entry.waiter.settle(decision)
    return entry.open
  }

  /**
   * Drop every open item for one turn (an interrupt) or for all of them (the
   * session is going away). Returns what was abandoned so the caller can emit
   * `question.abandoned`; the waiters resolve to the safe default.
   */
  abandon(reason: AbandonReason, turnId?: TurnId): { questions: OpenQuestion[]; approvals: OpenApproval[] } {
    const questions = [...this.#questions.values()].filter((e) => turnId === undefined || e.open.turnId === turnId)
    const approvals = [...this.#approvals.values()].filter((e) => turnId === undefined || e.open.turnId === turnId)
    for (const entry of questions) {
      this.#questions.delete(entry.open.questionId)
      entry.waiter.abandon(reason)
    }
    for (const entry of approvals) {
      this.#approvals.delete(entry.open.requestId)
      entry.waiter.abandon(reason)
    }
    return { questions: questions.map((e) => e.open), approvals: approvals.map((e) => e.open) }
  }

  /** True while the peer is blocked on a person (§4's `waiting_input`). */
  get blocked(): boolean {
    return this.#questions.size + this.#approvals.size > 0
  }

  /** A snapshot, oldest first; the ids `answer()`/`respond()` take by name. */
  snapshot(): { questions: readonly OpenQuestion[]; approvals: readonly OpenApproval[] } {
    return {
      questions: [...this.#questions.values()].map((e) => e.open),
      approvals: [...this.#approvals.values()].map((e) => e.open),
    }
  }

  #oldest<T extends { open: { askedAt: Timestamp } }>(map: Map<string, T>): T | undefined {
    let oldest: T | undefined
    for (const entry of map.values()) {
      if (oldest === undefined || Date.parse(entry.open.askedAt) < Date.parse(oldest.open.askedAt)) oldest = entry
    }
    return oldest
  }
}

const freezeQuestion = (question: AskedQuestion): AskedQuestion =>
  Object.freeze({
    ...question,
    ...(question.options === undefined ? {} : { options: Object.freeze(question.options.map((o) => Object.freeze({ ...o }))) }),
  })
