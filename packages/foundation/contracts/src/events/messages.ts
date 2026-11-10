/**
 * The Mailbox (architecture §7). Delivery is a provider call, not keystrokes,
 * and every message carries the brief version it was written against. A reply
 * that cites an older version is rejected with the newer brief attached.
 */

import { actor, event, object, oneOf, positiveInt, text } from '@fleet/foundation-core'
import { messageId, peerId, sessionId } from '@fleet/foundation-core'
import { turnKinds } from '../provider.ts'

/** A message was accepted into the box, addressed to a peer. */
export const messageSent = event(
  'message.sent',
  object({
    msgId: messageId(),
    to: peerId(),
    /** `peer:<id>`, `user`, `pm` or `scheduler`; never a session ref. */
    from: actor(),
    kind: oneOf(turnKinds),
    briefVersion: positiveInt(),
    body: text(100_000),
  }),
)

/**
 * The message reached a live session. The supervisor resumed a session first
 * if the peer had none, so this also proves the resume-then-deliver path.
 */
export const messageDelivered = event(
  'message.delivered',
  object({ msgId: messageId(), to: peerId(), sessionId: sessionId() }),
)

/** The peer acknowledged it; the Mailbox may forget it from `pending`. */
export const messageAcked = event('message.acked', object({ msgId: messageId(), to: peerId() }))

export const messageRejectionReasons = ['stale_brief'] as const
export type MessageRejectionReason = (typeof messageRejectionReasons)[number]

/** A reply or status cited an older brief; the Mailbox rejects it and re-attaches (§7). */
export const messageRejected = event(
  'message.rejected',
  object({
    msgId: messageId(),
    to: peerId(),
    reason: oneOf(messageRejectionReasons),
    /** The version the sender used, and the one the store now has. */
    briefVersion: positiveInt(),
    currentBriefVersion: positiveInt(),
  }),
)

/** Where a message is in its life, derived from the four events above. */
export const messageAckStates = ['pending', 'delivered', 'acked', 'rejected'] as const
export type MessageAckState = (typeof messageAckStates)[number]
