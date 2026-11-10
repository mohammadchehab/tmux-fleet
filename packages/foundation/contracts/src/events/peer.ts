/**
 * Peer and session lifecycle (architecture §3, §4, §7, §8). `peerId` is the
 * subject of `peer.*`; `sessionId` is the subject of `session.*`. A peer
 * outlives its sessions, and nothing outside the registry sees a session ref.
 */

import { boolean, event, object, oneOf, optional, string, text } from '@fleet/foundation-core'
import { peerId, providerSessionRef, sessionId, worktreeId } from '@fleet/foundation-core'
import { peerState } from '@fleet/foundation-core'
import { permissionMode, providerId } from '../provider.ts'

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
  'peer.state',
  object({
    peerId: peerId(),
    state: peerState(),
    sessionId: optional(sessionId()),
    /** Why the provider said so, for a state a reader will question later. */
    reason: optional(text(500)),
  }),
)

/** A peer's session died or would not resume: a failure notification class (§6.1). */
export const peerFailed = event(
  'peer.failed',
  object({
    peerId: peerId(),
    sessionId: optional(sessionId()),
    reason: text(1000),
    retryable: boolean(),
  }),
)

/** A session came up. `resumed` is true when it continued a `ProviderSessionRef`. */
export const sessionStarted = event(
  'session.started',
  object({
    peerId: peerId(),
    sessionId: sessionId(),
    providerId: providerId(),
    providerSessionRef: providerSessionRef(),
    model: string({ minLength: 1 }),
    permissionMode: permissionMode(),
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
  }),
)

/**
 * A provider reported an error it did not recover from by itself: a failure
 * notification class, deduped and rate-limited by key (§6.1).
 */
export const providerError = event(
  'provider.error',
  object({
    peerId: peerId(),
    sessionId: optional(sessionId()),
    providerId: providerId(),
    code: string({ minLength: 1, maxLength: 80 }),
    message: text(2000),
    retryable: boolean(),
  }),
)
