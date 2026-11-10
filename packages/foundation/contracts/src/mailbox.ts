/**
 * The Mailbox API (architecture §7). It is the only way anything talks to a
 * peer: messages are addressed to a `peerId`, delivery is a provider call, and
 * a peer with no live session is resumed before its message is delivered.
 *
 * The implementation lives in `@fleet/runtime-mailbox` (phase 1); this is the
 * shape the supervisor, the PM and the daemon code against.
 */

import type { Actor, MessageId, PeerId, Seq, SessionId } from '@fleet/foundation-core'
import type { TurnKind } from './provider.ts'
import type { Message } from './projections/mailbox.ts'
import type { FleetError } from '@fleet/foundation-core'
import type { Result } from '@fleet/foundation-core'

/** What a caller hands to `send`. The Mailbox assigns the id and the time. */
export interface OutboundMessage {
  readonly to: PeerId
  /** `peer:<id>`, `user`, `pm` or `scheduler`; never a session ref. */
  readonly from: Actor
  readonly kind: TurnKind
  /** The brief the message was written against; a stale one is rejected (§7). */
  readonly briefVersion: number
  readonly body: string
  /** The events this message answers or was caused by (§3). */
  readonly causedBy?: readonly Seq[]
}

/** Why a delivery attempt did not put a message in front of the peer. */
export const deliveryFailures = ['no_session', 'resume_failed', 'stale_brief'] as const
export type DeliveryFailure = (typeof deliveryFailures)[number]

/**
 * What one `deliver` call did. It describes a call that ran to the end of the
 * queue, not one that stopped part-way: a provider that throws mid-batch makes
 * `deliver` return `Err`, so the caller gets no outcome and no `delivered` list.
 * Nothing is lost by that — each message was appended as `message.delivered`
 * before the next was tried, and the Mailbox remembers which session it went to,
 * so the retry does not put a second copy in front of a peer still on that
 * session. A failed `deliver` is followed by one that resumes at the first
 * message the provider did not accept (§7).
 */
export interface DeliveryOutcome {
  readonly peerId: PeerId
  /**
   * Messages handed to the provider in this call, oldest first. Only complete
   * calls have one; see above for the mid-batch failure.
   */
  readonly delivered: readonly MessageId[]
  /** True when the Mailbox had to resume a session first (§7). */
  readonly resumed: boolean
  readonly sessionId?: SessionId
  readonly failures: readonly { readonly msgId: MessageId; readonly reason: DeliveryFailure }[]
}

/**
 * Resume-then-deliver is one call on purpose: a caller cannot forget the
 * resume, and the outcome says whether it happened (§7).
 */
export interface Mailbox {
  /** Accept a message for a peer. Never fails because the peer is offline. */
  send(message: OutboundMessage): Promise<Result<MessageId, FleetError>>

  /** Undelivered messages for a peer, oldest first. */
  pending(to: PeerId): Promise<readonly Message[]>

  /** Resume the peer's session if needed, then deliver everything pending, in order. */
  deliver(to: PeerId): Promise<Result<DeliveryOutcome, FleetError>>

  /** The peer confirmed it acted on the message. */
  ack(to: PeerId, msgId: MessageId): Promise<Result<void, FleetError>>

  /**
   * Reject a reply or status that cites an out-of-date brief. The current
   * version is attached so the sender can re-send correctly (§7).
   */
  reject(to: PeerId, msgId: MessageId, currentBriefVersion: number): Promise<Result<void, FleetError>>

  /** The most recent messages for a peer, any state; for `fleet peek`. */
  history(to: PeerId, limit?: number): Promise<readonly Message[]>
}
