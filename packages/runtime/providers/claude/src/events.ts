/**
 * The adapter's event vocabulary, and its projection onto the contract.
 *
 * The architect's §4 fold (the design in `docs/fleet-v2-architecture.md`, agreed
 * with the supervisor and the store) wants more than `ProviderEvent` in
 * `foundation/contracts` can say today:
 *
 * - `question.asked` carries a `questionId` and the structured choices, so an
 *   answer is addressed and not guessed from text;
 * - `approval.requested` exists at all (the current union has no way to say
 *   "a tool is blocked on a person");
 * - `turn.ended` carries the `reason` the PM's "notify on failure only" rule
 *   reads (§6.1);
 * - `session.ended` is synthesised by the adapter, because the SDK never
 *   emits it.
 *
 * The contract change is engineer-1's to write, so this package keeps the
 * richer shape internally and *projects* to the current union at `events()`.
 * The projection is lossy on purpose and says so: when the contract lands the
 * projection becomes the identity and this file shrinks to an import.
 */

import type { Timestamp, TurnId } from '@fleet/foundation-core'
import type { ProviderEvent, ProviderSessionRef, Usage } from '@fleet/runtime-provider-sdk'

/** One question in an `AskUserQuestion` call, as the model asked it. */
export interface AskedQuestion {
  readonly question: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

/** Why a turn stopped. Only `failed` notifies a person (§6.1). */
export type TurnEndReason = 'completed' | 'interrupted' | 'failed'

/** Why a session stopped, from the adapter's point of view. */
export type SessionEndReason = 'stopped' | 'exited' | 'failed'

export type AdapterEvent =
  | {
      readonly type: 'session.started'
      readonly at: Timestamp
      readonly sessionRef: ProviderSessionRef
      readonly model: string
      readonly permissionMode: string
    }
  | {
      readonly type: 'session.ended'
      readonly at: Timestamp
      readonly reason: SessionEndReason
      readonly error?: string
    }
  | { readonly type: 'turn.started'; readonly turnId: TurnId; readonly at: Timestamp }
  | {
      readonly type: 'turn.ended'
      readonly turnId: TurnId
      readonly at: Timestamp
      readonly reason: TurnEndReason
      readonly error?: string
      readonly usage?: Usage
    }
  | {
      readonly type: 'tool.use'
      readonly turnId: TurnId
      readonly tool: string
      /** Short and already-redacted; never the full tool input (§4). */
      readonly summary?: string
    }
  | {
      readonly type: 'question.asked'
      readonly turnId: TurnId
      readonly questionId: string
      readonly at: Timestamp
      readonly questions: readonly AskedQuestion[]
    }
  /** The question died with its turn or its session; the answer can be dropped (§6.1, §8). */
  | { readonly type: 'question.abandoned'; readonly questionId: string; readonly reason: 'interrupted' | 'ended' }
  | {
      readonly type: 'approval.requested'
      readonly turnId: TurnId
      readonly requestId: string
      readonly at: Timestamp
      readonly tool: string
      readonly summary?: string
    }
  | {
      readonly type: 'approval.resolved'
      readonly requestId: string
      readonly decision: 'allow' | 'deny'
    }
  | {
      readonly type: 'compaction'
      readonly turnId: TurnId
      readonly contextTokensBefore: number
      readonly contextTokensAfter: number
    }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean }

/**
 * The contract's view of an adapter event. `undefined` means the current union
 * cannot say it at all — today that is `session.ended`, the two approval
 * events, `question.abandoned` and the reason on `turn.ended`.
 *
 * A blocked approval becomes a `question.asked` because at the current contract
 * the one thing a supervisor must not miss is that the peer is waiting on a
 * person; the structure stays in `PendingRequests`, where `respond()` reads it.
 */
export const toContract = (event: AdapterEvent): ProviderEvent | undefined => {
  switch (event.type) {
    case 'turn.started':
      return { type: 'turn.started', turnId: event.turnId, at: event.at }
    case 'turn.ended':
      return event.usage === undefined
        ? { type: 'turn.ended', turnId: event.turnId, at: event.at }
        : { type: 'turn.ended', turnId: event.turnId, at: event.at, usage: event.usage }
    case 'tool.use':
      return event.summary === undefined
        ? { type: 'tool.use', turnId: event.turnId, tool: event.tool }
        : { type: 'tool.use', turnId: event.turnId, tool: event.tool, summary: event.summary }
    case 'question.asked':
      return { type: 'question.asked', turnId: event.turnId, question: renderQuestion(event.questions) }
    case 'approval.requested':
      return {
        type: 'question.asked',
        turnId: event.turnId,
        question: `Approve ${event.tool}${event.summary === undefined ? '' : `: ${event.summary}`}?`,
      }
    case 'compaction':
      return {
        type: 'compaction',
        turnId: event.turnId,
        contextTokensBefore: event.contextTokensBefore,
        contextTokensAfter: event.contextTokensAfter,
      }
    case 'error':
      return { type: 'error', message: event.message, retryable: event.retryable }
    case 'session.started':
    case 'session.ended':
    case 'question.abandoned':
    case 'approval.resolved':
      return undefined
  }
}

/** One line for the contract's flat `question` field: the first question, or the rest as a count. */
const renderQuestion = (questions: readonly AskedQuestion[]): string => {
  const first = questions[0]
  if (first === undefined) return 'The peer asked a question with no content.'
  if (questions.length === 1) return first.question
  return `${first.question} (and ${questions.length - 1} more)`
}
