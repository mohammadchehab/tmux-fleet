/**
 * The Mailbox (architecture §7): the only way anything talks to a peer.
 *
 * Three rules hold this together, and each is visible in the code below:
 *
 * - **A peer is an id, not a session.** Everything here is keyed by `PeerId`;
 *   a `SessionId` appears only as the thing a delivery is recorded *through*.
 *   `OutboundMessage.from` cannot name a session at all (the `Actor` schema
 *   refuses a session ref where a peer id belongs), so the `[eb76a6] →
 *   [569937]` rename cannot leak into a message.
 * - **Delivery is a provider call, not keystrokes.** The Mailbox never holds a
 *   provider: it asks `PeerSessions.acquire` for a lease and calls `send` on it,
 *   which is what makes delivery work for every provider and impossible to hold
 *   behind a permission prompt (§13).
 * - **At-least-once with ack.** A message stays in the box until it is acked,
 *   so a crash between `send` and `ack` re-sends rather than loses. The events
 *   are appended *after* the provider accepted the turn, never before.
 *
 * The state is the store's: every move is one of the four `message.*` events,
 * and reads go through the `message` projection. That includes which session a
 * message was last handed to — `message.delivered` carries it, the projection
 * keeps it, so "the peer is already looking at this" is a fact a restarted
 * fleetd still knows. The only thing kept in memory is the per-peer delivery
 * queue that stops two overlapping `deliver` calls from both seeing the same
 * message as pending.
 *
 * One daemon drives the Mailbox; it is not a multi-process lock.
 */

import {
  err,
  fleetError,
  isoFromMillis,
  newMessageId,
  ok,
  peerActor,
  systemClock,
  toFleetError,
  type Actor,
  type Clock,
  type FleetError,
  type MessageId,
  type PeerId,
  type Result,
  type Seq,
} from '@fleet/foundation-core'
import type {
  AppendEvent,
  BriefVersions,
  DeliveryFailure,
  DeliveryOutcome,
  EventSink,
  Mailbox,
  Message,
  MessageAckState,
  MessageReader,
  OutboundMessage,
  PeerSessions,
} from '@fleet/foundation-contracts'

/** What the Mailbox needs from the store: append events, read the message projection (§3). */
export interface MailboxStore extends EventSink {
  readonly messages: MessageReader
}

export interface MailboxDeps {
  readonly store: MailboxStore
  /** How a peer is reached; `apps/daemon` injects the supervisor's implementation (§7). */
  readonly sessions: PeerSessions
  /** Where the current brief version comes from (§7, §12). */
  readonly briefs: BriefVersions
  /** Injected so a test can pin time; the store stamps nothing itself (§5.4). */
  readonly clock?: Clock
}

/**
 * The states a message can still be delivered from: everything before `acked`
 * or `rejected`. Handed to the store as the read's filter, so `pending` and
 * `deliver` never see a message there is nothing left to do with.
 */
const unacked: readonly MessageAckState[] = ['pending', 'delivered']

/**
 * Oldest first. `sentAt` orders messages because the Mailbox is their only
 * writer and stamps them from a clock that never runs backwards (`monotonic`
 * below); `msgId` only breaks a tie a hand-made store could still produce.
 */
const bySentAt = (a: Message, b: Message): number =>
  a.sentAt === b.sentAt ? a.msgId.localeCompare(b.msgId) : a.sentAt.localeCompare(b.sentAt)

/**
 * A clock that never repeats or goes backwards, so two messages sent in the
 * same millisecond still have a total order. Only `now` is adjusted: `millis`
 * stays the real wall clock, because durations must not be inflated by it.
 */
const monotonic = (clock: Clock): Clock => {
  let last = 0
  return {
    millis: () => clock.millis(),
    now: () => {
      const next = Math.max(clock.millis(), last + 1)
      last = next
      return isoFromMillis(next)
    },
  }
}

export const createMailbox = (deps: MailboxDeps): Mailbox => {
  const clock = monotonic(deps.clock ?? systemClock)

  /**
   * One delivery at a time per peer. The supervisor ticks on a timer and a slow
   * provider call can outlive a tick, so without this two overlapping `deliver`
   * calls would each see the same message as pending and send it twice.
   */
  const deliveries = new Map<PeerId, Promise<unknown>>()
  const serialized = <T>(to: PeerId, work: () => Promise<T>): Promise<T> => {
    const run = (deliveries.get(to) ?? Promise.resolve()).then(work, work)
    deliveries.set(to, run.then(
      () => undefined,
      () => undefined,
    ))
    return run
  }

  const write = async (batch: readonly AppendEvent[]): Promise<Result<readonly Seq[], FleetError>> => {
    try {
      return ok(await deps.store.append(batch))
    } catch (thrown) {
      return err(toFleetError(thrown, 'store_failed'))
    }
  }

  /**
   * Every message for a peer, oldest first — the one shape every read below
   * starts from. `states` goes to the store, so a pending read does not carry
   * every message the peer has ever had across the boundary only to drop them.
   */
  const messagesFor = async (
    to: PeerId,
    states?: readonly MessageAckState[],
  ): Promise<Result<readonly Message[], FleetError>> => {
    try {
      return ok([...(await deps.store.messages.forPeer(to, states))].sort(bySentAt))
    } catch (thrown) {
      return err(toFleetError(thrown, 'store_failed'))
    }
  }

  const find = async (to: PeerId, msgId: MessageId): Promise<Result<Message | undefined, FleetError>> => {
    const all = await messagesFor(to)
    if (!all.ok) return all
    return ok(all.value.find((m) => m.msgId === msgId))
  }

  const currentBrief = async (to: PeerId): Promise<Result<number | undefined, FleetError>> => {
    try {
      return ok(await deps.briefs.current(to))
    } catch (thrown) {
      return err(toFleetError(thrown, 'store_failed'))
    }
  }

  const rejected = (
    to: PeerId,
    msgId: MessageId,
    briefVersion: number,
    currentBriefVersion: number,
    actor: Actor,
    ts: string,
  ): AppendEvent => ({
    type: 'message.rejected',
    ts,
    subject: to,
    // The sender is who cited the old brief, so they are the actor of the rejection.
    actor,
    data: { msgId, to, reason: 'stale_brief', briefVersion, currentBriefVersion },
  })

  const deliverTo = async (to: PeerId): Promise<Result<DeliveryOutcome, FleetError>> => {
    const all = await messagesFor(to, unacked)
    if (!all.ok) return all
    const waiting = all.value
    if (waiting.length === 0) return ok({ peerId: to, delivered: [], resumed: false, failures: [] })

    const current = await currentBrief(to)
    if (!current.ok) return current

    // A message can go stale between `send` and delivery — a new brief may have
    // been published while it sat in the box. Reject it here with the same event
    // `send` would have written, so the box never hands a peer an old citation.
    const failures: { msgId: MessageId; reason: DeliveryFailure }[] = []
    const live: Message[] = []
    const rejections: AppendEvent[] = []
    for (const message of waiting) {
      if (current.value !== undefined && message.briefVersion < current.value) {
        rejections.push(rejected(to, message.msgId, message.briefVersion, current.value, message.from, clock.now()))
        failures.push({ msgId: message.msgId, reason: 'stale_brief' })
      } else {
        live.push(message)
      }
    }
    if (rejections.length > 0) {
      const written = await write(rejections)
      if (!written.ok) return written
    }
    if (live.length === 0) return ok({ peerId: to, delivered: [], resumed: false, failures })

    // Resume-then-deliver is one call on purpose (§7): a peer with no live
    // session gets one before anything is handed over, and an offline peer is an
    // outcome with reasons, not an exception.
    const acquired = await deps.sessions.acquire(to)
    if (!acquired.ok) {
      const reason: DeliveryFailure = acquired.error.code === 'not_found' ? 'no_session' : 'resume_failed'
      return ok({
        peerId: to,
        delivered: [],
        resumed: false,
        failures: [...failures, ...live.map((m) => ({ msgId: m.msgId, reason }))],
      })
    }
    const lease = acquired.value

    const delivered: MessageId[] = []
    for (const message of live) {
      // Already in front of this peer, in this session, unacked: re-sending it
      // would duplicate the turn. `deliveredSessionId` comes from the log, so
      // this holds across a fleetd restart; the memory map that used to hold it
      // did not, and a restart re-sent every unacked message to the session that
      // already had it. A message delivered before the column existed reads as
      // no session, and is re-sent once. A *different* session means the peer
      // lost its context, and at-least-once says send it again.
      if (message.state === 'delivered' && message.deliveredSessionId === lease.sessionId) continue

      try {
        await lease.send({ text: message.body, kind: message.kind, briefVersion: message.briefVersion })
      } catch (thrown) {
        // Nothing is recorded for a turn the provider refused: the message stays
        // unacked in the box and the next `deliver` retries it.
        return err(toFleetError(thrown, 'provider_failed'))
      }

      const written = await write([
        {
          type: 'message.delivered',
          ts: clock.now(),
          subject: to,
          actor: peerActor(to),
          data: { msgId: message.msgId, to, sessionId: lease.sessionId },
        },
      ])
      if (!written.ok) return written

      delivered.push(message.msgId)
    }

    return ok({ peerId: to, delivered, resumed: lease.resumed, sessionId: lease.sessionId, failures })
  }

  return {
    async send(message: OutboundMessage): Promise<Result<MessageId, FleetError>> {
      const msgId = newMessageId()
      const ts = clock.now()

      const current = await currentBrief(message.to)
      if (!current.ok) return current

      const stale = current.value !== undefined && message.briefVersion < current.value
      const sent: AppendEvent = {
        type: 'message.sent',
        ts,
        subject: message.to,
        actor: message.from,
        causedBy: message.causedBy,
        data: {
          msgId,
          to: message.to,
          from: message.from,
          kind: message.kind,
          briefVersion: message.briefVersion,
          body: message.body,
        },
      }

      // The rejection is stored with the message, not instead of it: the box is a
      // log, and a caller that sent a stale reply should be able to see that it did.
      const batch: readonly AppendEvent[] = stale
        ? [sent, rejected(message.to, msgId, message.briefVersion, current.value, message.from, ts)]
        : [sent]

      const written = await write(batch)
      if (!written.ok) return written

      if (stale) {
        return err(
          fleetError(
            'conflict',
            `${String(message.to)} is on brief v${String(current.value)}; this message cites v${String(message.briefVersion)} and was rejected`,
            { details: { msgId, briefVersion: message.briefVersion, currentBriefVersion: current.value } },
          ),
        )
      }
      return ok(msgId)
    },

    async pending(to: PeerId): Promise<readonly Message[]> {
      const all = await messagesFor(to, unacked)
      // The API declares a plain list, so a store failure throws rather than
      // pretending the box is empty: "nothing waiting" is a decision a caller acts
      // on, and a failed read must not be able to say it.
      if (!all.ok) throw all.error
      return all.value
    },

    deliver(to: PeerId): Promise<Result<DeliveryOutcome, FleetError>> {
      return serialized(to, () => deliverTo(to))
    },
    async ack(to: PeerId, msgId: MessageId): Promise<Result<void, FleetError>> {
      const found = await find(to, msgId)
      if (!found.ok) return found
      const message = found.value
      if (message === undefined || message.to !== to) return err(notFound(msgId, to))

      // At-least-once means acks arrive twice; the second one is a no-op, not an error.
      if (message.state === 'acked') return ok(undefined)
      if (message.state === 'rejected') {
        return err(fleetError('conflict', `${String(msgId)} was rejected for citing an old brief; nothing was delivered to ack`))
      }

      const written = await write([
        { type: 'message.acked', ts: clock.now(), subject: to, actor: peerActor(to), data: { msgId, to } },
      ])
      if (!written.ok) return written
      return ok(undefined)
    },

    async reject(to: PeerId, msgId: MessageId, currentBriefVersion: number): Promise<Result<void, FleetError>> {
      const found = await find(to, msgId)
      if (!found.ok) return found
      const message = found.value
      if (message === undefined || message.to !== to) return err(notFound(msgId, to))

      if (message.state === 'acked') {
        return err(fleetError('conflict', `${String(msgId)} was already acked; an acked message is not rejected`))
      }
      if (currentBriefVersion <= message.briefVersion) {
        return err(
          fleetError(
            'invalid_input',
            `v${String(currentBriefVersion)} is not newer than the v${String(message.briefVersion)} the message cites; there is nothing stale to reject`,
            { details: { msgId, briefVersion: message.briefVersion, currentBriefVersion } },
          ),
        )
      }
      if (message.state === 'rejected' && message.currentBriefVersion === currentBriefVersion) return ok(undefined)

      const written = await write([
        rejected(to, message.msgId, message.briefVersion, currentBriefVersion, message.from, clock.now()),
      ])
      if (!written.ok) return written
      return ok(undefined)
    },

    async history(to: PeerId, limit = 20): Promise<readonly Message[]> {
      const all = await messagesFor(to)
      if (!all.ok) throw all.error
      // Newest first: `fleet peek` reads the last thing said, not the first.
      return all.value.slice().reverse().slice(0, Math.max(0, limit))
    },
  }
}

const notFound = (msgId: MessageId, to: PeerId): FleetError =>
  fleetError('not_found', `no message ${String(msgId)} for ${String(to)}`, { details: { msgId, to } })

