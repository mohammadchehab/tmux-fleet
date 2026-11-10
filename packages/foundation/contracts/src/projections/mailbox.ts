/**
 * The `Message` projection (architecture §3, §7). Its `ack` is a small state
 * machine of its own: pending → delivered → acked, or rejected when the sender
 * cited an older brief.
 */

import { object, objectAs, oneOf, optional, positiveInt, sessionId, text, timestamp, type Schema } from '@fleet/foundation-core'
import {
  actor,
  messageId,
  peerId,
  type Actor,
  type MessageId,
  type PeerId,
  type SessionId,
} from '@fleet/foundation-core'
import { turnKinds, type TurnKind } from '../provider.ts'
import { messageAckStates, type MessageAckState } from '../events/messages.ts'

export interface Message {
  readonly msgId: MessageId
  readonly to: PeerId
  readonly from: Actor
  readonly kind: TurnKind
  readonly briefVersion: number
  readonly body: string
  readonly state: MessageAckState
  readonly sentAt: string
  readonly deliveredAt?: string
  /**
   * The session the message was last handed to. It is what makes "already in
   * front of this peer" a fact in the log rather than one in the daemon's
   * memory, so a re-delivery after a fleetd restart does not duplicate the turn
   * (§7). Absent for a message never delivered, and for one delivered before
   * the column existed.
   */
  readonly deliveredSessionId?: SessionId
  readonly ackedAt?: string
  /** Set when rejected: the version that was current, so a re-send can cite it (§7). */
  readonly currentBriefVersion?: number
}

export const message = (): Schema<Message> =>
  objectAs<Message>()({
    msgId: messageId(),
    to: peerId(),
    from: actor(),
    kind: oneOf(turnKinds),
    briefVersion: positiveInt(),
    body: text(100_000),
    state: oneOf(messageAckStates),
    sentAt: timestamp(),
    deliveredAt: optional(timestamp()),
    deliveredSessionId: optional(sessionId()),
    ackedAt: optional(timestamp()),
    currentBriefVersion: optional(positiveInt()),
  })
