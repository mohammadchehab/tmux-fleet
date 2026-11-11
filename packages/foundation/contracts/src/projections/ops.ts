/**
 * `Decision`, `Routine`, `Notification`, `Finding` and the `token-report`
 * projection (architecture §3, §5.4, §6, §6.1, §6.2). These are the rows the
 * user-facing clients read: the decision inbox, the board and the report.
 */

import { array, boolean, count, number, object, objectAs, oneOf, optional, positiveInt, string, text, timestamp, type Schema } from '@fleet/foundation-core'
import { decisionId, findingId, notificationKey, peerId, questionId, workId } from '@fleet/foundation-core'
import { severity } from '../shapes.ts'
import { judgeAnswer, questionKind } from '../judge.ts'
import { routineKinds, routineTriggers } from '../events/ops.ts'
import { notificationClasses } from '../events/signals.ts'
import type { JudgeAnswer, QuestionKind } from '../judge.ts'
import type { RoutineKind, RoutineTrigger } from '../events/ops.ts'
import type { NotificationClass } from '../events/signals.ts'
import type { Severity } from '../shapes.ts'
import type {
  DecisionId,
  FindingId,
  NotificationKey,
  PeerId,
  QuestionId,
  WorkId,
} from '@fleet/foundation-core'

// ------------------------------------------------------------------ decisions

/** `open` is what the decision inbox lists; `answered` is history (§6.1). */
export const decisionStates = ['open', 'answered'] as const
export type DecisionState = (typeof decisionStates)[number]

export interface Decision {
  readonly decisionId: DecisionId
  readonly kind: string
  readonly state: DecisionState
  readonly question: string
  readonly options: readonly string[]
  readonly option?: string
  readonly text?: string
  readonly source?: string
  readonly inputsHash: string
  readonly judgeModel?: string
  readonly workId?: WorkId
  readonly requestedAt: string
  readonly answeredAt?: string
  /**
   * The peer blocked on a tool_approval decision, so `decide allow|deny` can route
   * the answer back to that peer's session (TASK-115).
   */
  readonly peerId?: PeerId
  /** The provider's request id for a tool_approval, so the log names the exact call. */
  readonly requestId?: string
}

export const decision = (): Schema<Decision> =>
  objectAs<Decision>()({
    decisionId: decisionId(),
    kind: string({ minLength: 1, maxLength: 60 }),
    state: oneOf(decisionStates),
    question: text(2000),
    options: array(string({ minLength: 1, maxLength: 200 })),
    option: optional(string({ minLength: 1, maxLength: 200 })),
    text: optional(text(2000)),
    source: optional(string({ minLength: 1, maxLength: 20 })),
    inputsHash: string({ minLength: 8, maxLength: 200 }),
    judgeModel: optional(string({ minLength: 1, maxLength: 80 })),
    workId: optional(workId()),
    requestedAt: timestamp(),
    answeredAt: optional(timestamp()),
    peerId: optional(peerId()),
    requestId: optional(string({ minLength: 1, maxLength: 200 })),
  })

// ------------------------------------------------------------------- routines

/** A routine whose last run started but has no outcome is `running` (§6). */
export const routineStates = ['running', 'finished', 'failed'] as const
export type RoutineState = (typeof routineStates)[number]

export interface Routine {
  readonly routineId: string
  readonly kind: RoutineKind
  readonly trigger: RoutineTrigger
  readonly state: RoutineState
  readonly lastRunAt?: string
  readonly runs: number
  readonly failures: number
}

export const routine = (): Schema<Routine> =>
  objectAs<Routine>()({
    routineId: string({ minLength: 1, maxLength: 80 }),
    kind: oneOf(routineKinds),
    trigger: oneOf(routineTriggers),
    state: oneOf(routineStates),
    lastRunAt: optional(timestamp()),
    runs: count(),
    failures: count(),
  })

// --------------------------------------------------------------- notifications

/** `pending` is derived but never sent; `resolved` closes the banner (§6.1). */
export const notificationStates = ['pending', 'sent', 'resolved'] as const
export type NotificationState = (typeof notificationStates)[number]

export interface Notification {
  readonly key: NotificationKey
  readonly class: NotificationClass
  readonly state: NotificationState
  readonly title?: string
  readonly body?: string
  readonly channel?: string
  readonly deliveryFailed: boolean
  /** How many times the backing event has recurred; shown as "still failing, N events" (§6.1). */
  readonly occurrences: number
  readonly createdAt: string
  readonly sentAt?: string
  /** When the one quiet reminder went out; at most one per open decision (§6.1). */
  readonly remindedAt?: string
  readonly resolvedAt?: string
  /** When `Notifier.withdraw` cleared the banner. Set once, so a replay does not withdraw twice (§6.1). */
  readonly withdrawnAt?: string
}

export const notification = (): Schema<Notification> =>
  objectAs<Notification>()({
    key: notificationKey(),
    class: oneOf(notificationClasses),
    state: oneOf(notificationStates),
    title: optional(string({ minLength: 1, maxLength: 300 })),
    body: optional(text(2000)),
    channel: optional(string({ minLength: 1, maxLength: 40 })),
    deliveryFailed: boolean(),
    occurrences: positiveInt(),
    createdAt: timestamp(),
    sentAt: optional(timestamp()),
    remindedAt: optional(timestamp()),
    resolvedAt: optional(timestamp()),
    withdrawnAt: optional(timestamp()),
  })

// -------------------------------------------------------------------- findings

export const findingStates = ['open', 'confirmed', 'dismissed', 'fixed'] as const
export type FindingState = (typeof findingStates)[number]

export interface Finding {
  readonly findingId: FindingId
  /** `hash(ruleId + path + normalized snippet)`; survives line shifts (§6.2). */
  readonly fingerprint: string
  readonly tool: string
  readonly ruleId: string
  readonly severity: Severity
  readonly path: string
  readonly line?: number
  readonly message: string
  readonly sha: string
  readonly state: FindingState
  /** How many runs have seen this fingerprint. */
  readonly seenCount: number
  /** Required once dismissed: the reason is remembered by fingerprint (§6.2). */
  readonly reason?: string
  readonly workId?: WorkId
  readonly decisionId?: DecisionId
  readonly raisedAt: string
  readonly verifiedBy?: PeerId
  readonly verifiedAt?: string
}

export const finding = (): Schema<Finding> =>
  objectAs<Finding>()({
    findingId: findingId(),
    fingerprint: string({ minLength: 8, maxLength: 200 }),
    tool: string({ minLength: 1, maxLength: 60 }),
    ruleId: string({ minLength: 1, maxLength: 200 }),
    severity: severity(),
    path: string({ minLength: 1, maxLength: 500 }),
    line: optional(positiveInt()),
    message: text(2000),
    sha: string({ pattern: /^[0-9a-f]{7,40}$/ }),
    state: oneOf(findingStates),
    seenCount: positiveInt(),
    reason: optional(text(1000)),
    workId: optional(workId()),
    decisionId: optional(decisionId()),
    raisedAt: timestamp(),
    verifiedBy: optional(peerId()),
    verifiedAt: optional(timestamp()),
  })

// ---------------------------------------------------------------- token report

/**
 * Per peer and role: tokens per Work item, the share of exploration done
 * through codegraph, and redirect counts (§6.2). The measured baseline, not an
 * assumed one.
 */
export interface TokenReport {
  readonly peerId: PeerId
  readonly role: string
  readonly workId?: WorkId
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  /**
   * What those turns cost, in USD, summed from the turns that reported a price
   * (`turn.usage_recorded.costUsd`). A provider that does not price its turns
   * leaves this at 0 — an unknown cost is not a free one, and §6.2's report says
   * which it is by the provider, not by this number alone.
   */
  readonly costUsd: number
  /**
   * How many of those turns reported no price (TASK-122). `costUsd` is then a floor, not the bill: a row with some
   * priced turns and some unpriced ones is a mixed peer, and an all-unpriced one has a `costUsd` of 0 that is not free.
   * Absent on a row written before the column existed; the store backfills every row it has.
   */
  readonly unpricedTurns?: number
  readonly toolCalls: {
    readonly grep: number
    readonly glob: number
    readonly read: number
    readonly codegraph: number
  }
  readonly redirects: number
  readonly updatedAt: string
}

export const tokenReport = (): Schema<TokenReport> =>
  objectAs<TokenReport>()({
    peerId: peerId(),
    role: string({ minLength: 1, maxLength: 80 }),
    workId: optional(workId()),
    turns: count(),
    inputTokens: count(),
    outputTokens: count(),
    cachedTokens: count(),
    costUsd: number({ min: 0 }),
    unpricedTurns: optional(count()),
    toolCalls: object({ grep: count(), glob: count(), read: count(), codegraph: count() }),
    redirects: count(),
    updatedAt: timestamp(),
  })

/**
 * The fleet's spend in one calendar month (UTC), across every peer (§6.2). The
 * token report above is cumulative and never resets a period; a cap is monthly,
 * so a pace against it needs the month's own sum (shared-fleet.md §3).
 */
export interface MonthSpend {
  /** `YYYY-MM`, in UTC. */
  readonly month: string
  /** Summed from the turns that reported a price; see `TokenReport.costUsd`. */
  readonly costUsd: number
  readonly turns: number
  /** Turns that reported no price, so `costUsd` is a floor rather than the bill when this is above 0. */
  readonly unpricedTurns: number
}

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

export const monthSpend = (): Schema<MonthSpend> =>
  objectAs<MonthSpend>()({
    month: string({ pattern: MONTH_PATTERN }),
    costUsd: number({ min: 0 }),
    turns: count(),
    unpricedTurns: count(),
  })

// ---------------------------------------------------------- judge questions

/**
 * A typed question and the answer it got (§5.3, §5.4), as a row rather than an
 * event in the log.
 *
 * The question log was never projected while the only rule that acted on an
 * answer was the tick that saw `judge.answered`: the answer travelled in that
 * event, so a snapshot had nothing to read and the trigger carried it instead.
 * The cost of that was a rule woken by an event its own body appends (§6) —
 * `dispatch` asks, the Judge answers through the same sink, and the tick wakes
 * itself. Projecting the pair is what lets the trigger go: the rule reads the
 * question's *state*, and any tick may be the one that finds it answered.
 */
export interface JudgeQuestionRecord {
  readonly questionId: QuestionId
  readonly kind: QuestionKind
  /** §5.4: the hash of the inputs, so a replay recognises a question it already asked. */
  readonly inputsHash: string
  readonly workId?: WorkId
  /** The peer whose work raised it, when one did. */
  readonly askedFor?: PeerId
  readonly askedAt: string
  /** Absent while the question is open. */
  readonly answer?: JudgeAnswer
  /** The model that answered; the event's actor is `judge:<model>` (§3). */
  readonly model?: string
  readonly answeredAt?: string
}

export const judgeQuestion = (): Schema<JudgeQuestionRecord> =>
  objectAs<JudgeQuestionRecord>()({
    questionId: questionId(),
    kind: questionKind(),
    inputsHash: string({ minLength: 8, maxLength: 200 }),
    workId: optional(workId()),
    askedFor: optional(peerId()),
    askedAt: timestamp(),
    answer: optional(judgeAnswer()),
    model: optional(string({ minLength: 1, maxLength: 80 })),
    answeredAt: optional(timestamp()),
  })

/** The share of exploration that went through codegraph, 0..1; `0` when there was none. */
export const codegraphShare = (toolCalls: TokenReport['toolCalls']): number => {
  const exploration = toolCalls.grep + toolCalls.glob + toolCalls.read + toolCalls.codegraph
  return exploration === 0 ? 0 : toolCalls.codegraph / exploration
}
