/**
 * The one place a session blocks on a person (§4, §6.1).
 *
 * Two SDK situations arrive on the same control channel — `canUseTool` — and
 * both block the turn until the host answers, with no deadline:
 *
 * - `AskUserQuestion`, which is the peer asking its supervisor something;
 * - every other tool that the permission mode or the session's own tool policy
 *   made ask, which is an approval.
 *
 * The adapter mints an id for each, keeps them in one map, and hands the caller
 * a promise it resolves through `answer()` / `respond()` — by id, which is why
 * the ids travel on `question.asked` / `approval.requested` (contracts E).
 * Answering by id rather than "the oldest" is what makes a stale answer a
 * `not_found` instead of an answer to somebody else's question.
 *
 * An unanswered item is abandoned, never left dangling: a turn that is
 * interrupted or a session that stops resolves it as `deny` and reports
 * `question.abandoned`, so no promise outlives the session that raised it (§8).
 */

import { randomUUID } from 'node:crypto'

import { fleetError, newQuestionId, type QuestionId, type Timestamp, type TurnId } from '@fleet/foundation-core'
import type { ApprovalDecision, QuestionAnswer } from '@fleet/runtime-provider-sdk'

import type { AskedQuestion } from './events.ts'

/** `apr_<16 hex>`; the contract types this as an opaque string, not a branded id. */
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

/** The labels chosen, one per question, in the order the questions were asked. */
export type { ApprovalDecision, QuestionAnswer }

export type AbandonReason = 'interrupted' | 'ended'

interface Waiter<T> {
  settle(value: T): void
  abandon(reason: AbandonReason): void
}

const mintRequestId = (): string => `apr_${randomUUID().replaceAll('-', '').slice(0, 16)}`

export class PendingRequests {
  readonly #questions = new Map<QuestionId, { open: OpenQuestion; waiter: Waiter<QuestionAnswer> }>()
  readonly #approvals = new Map<RequestId, { open: OpenApproval; waiter: Waiter<ApprovalDecision> }>()
  readonly #now: () => Timestamp

  constructor(now: () => Timestamp) {
    this.#now = now
  }

  /** Register a question and hand back the promise the turn is blocked on. */
  ask(turnId: TurnId, questions: readonly AskedQuestion[]): { open: OpenQuestion; wait: Promise<QuestionAnswer> } {
    const open: OpenQuestion = Object.freeze({
      questionId: newQuestionId(),
      turnId,
      askedAt: this.#now(),
      questions: Object.freeze(questions.map(freezeQuestion)),
    })
    const wait = new Promise<QuestionAnswer>((resolve) => {
      this.#questions.set(open.questionId, {
        open,
        waiter: { settle: (answer) => resolve(answer), abandon: () => resolve([]) },
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
      requestId: mintRequestId(),
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
   * Answer a question by the id its `question.asked` carried.
   *
   * @throws FleetError('not_found') when nothing is open under that id — a stale
   * answer, or one for a session that has since ended. Not a crash.
   */
  answer(questionId: QuestionId, answer: QuestionAnswer): OpenQuestion {
    const entry = this.#questions.get(questionId)
    if (entry === undefined) {
      throw fleetError('not_found', `no open question ${questionId}`, {
        details: { open: [...this.#questions.keys()] },
      })
    }
    this.#questions.delete(questionId)
    entry.waiter.settle(answer)
    return entry.open
  }

  /**
   * Allow or deny a blocked tool call, by the id its `approval.requested` carried.
   *
   * @throws FleetError('not_found') when nothing is open under that id.
   */
  respond(requestId: RequestId, decision: ApprovalDecision): OpenApproval {
    const entry = this.#approvals.get(requestId)
    if (entry === undefined) {
      throw fleetError('not_found', `no open approval ${requestId}`, {
        details: { open: [...this.#approvals.keys()] },
      })
    }
    this.#approvals.delete(requestId)
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
}

const freezeQuestion = (question: AskedQuestion): AskedQuestion =>
  Object.freeze({
    ...question,
    ...(question.options === undefined ? {} : { options: Object.freeze(question.options.map((o) => Object.freeze({ ...o }))) }),
  })
