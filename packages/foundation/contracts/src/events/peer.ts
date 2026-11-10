/**
 * Peer and session lifecycle (architecture §3, §4, §7, §8). `peerId` is the
 * subject of `peer.*`; `sessionId` is the subject of `session.*`. A peer
 * outlives its sessions, and nothing outside the registry sees a session ref.
 */

import {
  boolean,
  count,
  event,
  number,
  object,
  objectAs,
  oneOf,
  optional,
  refine,
  string,
  text,
  type PeerId,
  type Schema,
  type SessionId,
} from '@fleet/foundation-core'
import { peerId, providerSessionRef, sessionId, worktreeId } from '@fleet/foundation-core'
import { peerState } from '@fleet/foundation-core'
import { compactionTriggers, permissionMode, providerId } from '../provider.ts'

/** A peer exists. Written once per peer, from the profile's squad (§6, §1.1 config). */
export const peerRegistered = event(
  'peer.registered',
  object({
    peerId: peerId(),
    role: string({ minLength: 1, maxLength: 80 }),
    providerId: providerId(),
    model: string({ minLength: 1 }),
    permissionMode: permissionMode(),
    worktreeId: optional(worktreeId()),
  }),
)

/**
 * The peer's state changed (§4). This is the event behind the board, the PM's
 * `assign`/`unblock` rules and the supervisor's reconcile: never a scraped
 * pane.
 */
export const peerStateChanged = event(
  'peer.state_changed',
  object({
    peerId: peerId(),
    state: peerState(),
    sessionId: optional(sessionId()),
    /** Why the provider said so, for a state a reader will question later. */
    reason: optional(text(500)),
  }),
)

/**
 * Why a peer failed. A closed set, so the notification class is a switch and
 * not a match on prose; `message` carries the sentence a human reads (§6.1).
 */
export const peerFailureReasons = ['config_mismatch', 'session_died', 'resume_failed', 'provider_error'] as const
export type PeerFailureReason = (typeof peerFailureReasons)[number]

/**
 * What the supervisor saw a session running. `model` is always observable;
 * `baseUrl` only when the adapter recorded what it set, because no SDK exposes
 * the endpoint it dialled (§4, §13).
 */
export interface SessionFacts {
  readonly model: string
  readonly baseUrl?: string
}

const sessionFacts = (): Schema<SessionFacts> =>
  objectAs<SessionFacts>()({ model: string({ minLength: 1 }), baseUrl: optional(string({ minLength: 1 })) })

export interface PeerFailedData {
  readonly peerId: PeerId
  readonly sessionId?: SessionId
  readonly reason: PeerFailureReason
  /** The human sentence: an exit code, the SDK's message, what was denied. */
  readonly message?: string
  /** Present with `config_mismatch`: what the `SessionSpec` asked for. */
  readonly expected?: SessionFacts
  /** Present with `config_mismatch`: what came up instead. */
  readonly observed?: SessionFacts
  readonly retryable: boolean
}

/** A peer's session died or would not resume: a failure notification class (§6.1). */
export const peerFailed = event(
  'peer.failed',
  refine(
    objectAs<PeerFailedData>()({
      peerId: peerId(),
      sessionId: optional(sessionId()),
      reason: oneOf(peerFailureReasons),
      message: optional(text(1000)),
      expected: optional(sessionFacts()),
      observed: optional(sessionFacts()),
      retryable: boolean(),
    }),
    // A mismatch with nothing to compare is not a diagnosis: the two facts are
    // what makes the event worth storing (§4, §13).
    (value) => value.reason !== 'config_mismatch' || (value.expected !== undefined && value.observed !== undefined),
    'expected and observed when the reason is config_mismatch',
  ),
)

/**
 * A provider compacted a peer's context on its own or on a person's say-so (§8).
 *
 * Recorded because a compaction is money: the conversation is re-sent to a
 * summarizer, and the peer comes back with less of what it knew. It is not a
 * failure — the session carries on — so it is its own event rather than a
 * `peer.failed`, and it is written for compactions that happened *between*
 * turns, which is where they mostly happen.
 */
export const peerCompacted = event(
  'peer.compacted',
  object({
    peerId: peerId(),
    trigger: oneOf(compactionTriggers),
    /** Context tokens the provider compacted: the number that sizes the bill. */
    preTokens: count(),
    /** What the context held afterwards; absent when the provider did not say. */
    postTokens: optional(count()),
    /**
     * What the re-send cost at the model's configured price, when one is
     * configured. Absent means "not priced here", never "free" (§11).
     */
    estimatedCostUsd: optional(number({ min: 0 })),
  }),
)

/**
 * A session came up. `resumed` is true when it continued a `ProviderSessionRef`. * `model`, `permissionMode` and `endpoint` are what the session is *running*,
 * read from its first init and the adapter's own record, never echoed from the
 * request: a spec can be wrong and a leaked environment can silently change the
 * endpoint (§4, §13). `endpoint` is present only when the adapter recorded the
 * base URL it set, since an SDK does not expose it.
 */
export const sessionStarted = event(
  'session.started',
  object({
    peerId: peerId(),
    sessionId: sessionId(),
    providerId: providerId(),
    providerSessionRef: providerSessionRef(),
    model: string({ minLength: 1 }),
    permissionMode: permissionMode(),
    endpoint: optional(string({ minLength: 1, maxLength: 500 })),
    resumed: boolean(),
  }),
)

/** Why a session ended; `purged` is the self-purge restart (§8), not a failure. */
export const sessionEndReasons = ['stopped', 'purged', 'crashed', 'restarted', 'completed', 'failed'] as const
export type SessionEndReason = (typeof sessionEndReasons)[number]

export const sessionEnded = event(
  'session.ended',
  object({
    peerId: peerId(),
    sessionId: sessionId(),
    endReason: oneOf(sessionEndReasons),
    /**
     * The provider process's exit code, when the provider runs one: kept on the
     * stored event so a replay can still tell `exit 1` from `exit 0` (§4, §7).
     * Absent for an in-process provider, and for a session we stopped.
     */
    code: optional(number({ int: true })),
  }),
)

/**
 * A provider reported an error it did not recover from by itself: a failure
 * notification class, deduped and rate-limited by key (§6.1).
 */
export const providerError = event(
  'provider.errored',
  object({
    peerId: peerId(),
    sessionId: optional(sessionId()),
    providerId: providerId(),
    code: string({ minLength: 1, maxLength: 80 }),
    message: text(2000),
    retryable: boolean(),
  }),
)
