/**
 * Fakes for the Mailbox's three ports (§7). They are in-memory on purpose: the
 * SQLite store is phase 1's other half, and the Mailbox's job — ids, the ack
 * state machine, resume-then-deliver — is testable without it.
 */

import {
  err,
  fleetError,
  newSessionId,
  ok,
  type FleetError,
  type MessageId,
  type PeerId,
  type Result,
  type Seq,
  type SessionId,
  type TurnId,
} from '@fleet/foundation-core'
import type {
  AppendEvent,
  BriefVersions,
  Message,
  MessageAckState,
  PeerSessionLease,
  PeerSessions,
  Turn,
} from '@fleet/foundation-contracts'
import type { MailboxStore } from '../../src/mailbox.ts'

export interface FakeStore extends MailboxStore {
  /** Every event appended so far, in order; the assertions read this. */
  readonly events: readonly AppendEvent[]
  /** Every message read, with the state filter it carried; `undefined` means every state. */
  readonly reads: readonly { readonly peerId: PeerId; readonly states?: readonly MessageAckState[] }[]
  /** Every event of one type, in order and narrowed to that variant. */
  ofType<T extends AppendEvent['type']>(type: T): readonly Extract<AppendEvent, { type: T }>[]
  /** Make the next store call — an append or a read — throw, so a test can watch the failure path. */
  failNext(error: Error): void
}

/**
 * A store that keeps the `message` projection the way §3 says the real one
 * will: one row per message, mutated by the four `message.*` events.
 */
export const fakeStore = (): FakeStore => {
  const events: AppendEvent[] = []
  const reads: { peerId: PeerId; states?: readonly MessageAckState[] }[] = []
  const rows = new Map<MessageId, Message>()
  let seq = 0
  let nextFailure: Error | undefined

  const takeFailure = (): void => {
    if (!nextFailure) return
    const error = nextFailure
    nextFailure = undefined
    throw error
  }

  const apply = (event: AppendEvent): void => {
    switch (event.type) {
      case 'message.sent': {
        const { msgId, to, from, kind, briefVersion, body } = event.data
        rows.set(msgId, { msgId, to, from, kind, briefVersion, body, state: 'pending', sentAt: event.ts })
        return
      }
      case 'message.delivered': {
        const row = rows.get(event.data.msgId)
        if (row) {
          rows.set(row.msgId, {
            ...row,
            state: 'delivered',
            deliveredAt: event.ts,
            deliveredSessionId: event.data.sessionId,
          })
        }
        return
      }
      case 'message.acked': {
        const row = rows.get(event.data.msgId)
        if (row) rows.set(row.msgId, { ...row, state: 'acked', ackedAt: event.ts })
        return
      }
      case 'message.rejected': {
        const row = rows.get(event.data.msgId)
        if (row) {
          rows.set(row.msgId, { ...row, state: 'rejected', currentBriefVersion: event.data.currentBriefVersion })
        }
        return
      }
      default:
        return
    }
  }

  return {
    events,
    reads,
    ofType: <T extends AppendEvent['type']>(type: T) =>
      events.filter((event): event is Extract<AppendEvent, { type: T }> => event.type === type),
    failNext: (error) => {
      nextFailure = error
    },
    async append(batch: readonly AppendEvent[]): Promise<readonly Seq[]> {
      takeFailure()
      // All or nothing, like the real append: a batch either applies or it does not.
      const written = batch.map((event) => {
        seq += 1
        apply(event)
        return seq
      })
      events.push(...batch)
      return written
    },
    messages: {
      // The filter is the contract's, so the fake applies it too: a test that
      // passes must pass against a store that narrows the read (§7, §15).
      async forPeer(peerId: PeerId, states?: readonly MessageAckState[]): Promise<readonly Message[]> {
        takeFailure()
        reads.push(states === undefined ? { peerId } : { peerId, states })
        const wanted = states === undefined ? undefined : new Set(states)
        return [...rows.values()].filter(
          (row) => row.to === peerId && (wanted === undefined || wanted.has(row.state)),
        )
      },
    },
  }
}

export interface FakeSessions extends PeerSessions {
  /** Every turn handed to a provider, with the session it went to. */
  readonly sent: readonly { readonly sessionId: SessionId; readonly turn: Turn }[]
  /** Every peer `acquire` was asked for. */
  readonly acquisitions: readonly PeerId[]
  /** The session `acquire` will hand out next; a new one simulates a resume or restart. */
  readonly sessionId: SessionId
  /** Hand out a different session from now on: what a peer restart looks like to the Mailbox. */
  rotateSession(): SessionId
  /** Make the next `acquire` fail, e.g. `not_found` for a peer with no session. */
  failNext(error: FleetError): void
  /** Make the next `send` throw, e.g. a provider that died mid-turn. */
  failNextSend(error: Error): void
  /** Whether the leases claim a resume happened (§7). */
  setResumed(resumed: boolean): void
}

export const fakeSessions = (): FakeSessions => {
  const sent: { sessionId: SessionId; turn: Turn }[] = []
  const acquisitions: PeerId[] = []
  let sessionId = newSessionId()
  let resumed = true
  let nextFailure: FleetError | undefined
  let nextSendFailure: Error | undefined

  return {
    sent,
    acquisitions,
    get sessionId() {
      return sessionId
    },
    rotateSession() {
      sessionId = newSessionId()
      return sessionId
    },
    failNext: (error) => {
      nextFailure = error
    },
    failNextSend: (error) => {
      nextSendFailure = error
    },
    setResumed: (value) => {
      resumed = value
    },
    async acquire(peerId: PeerId): Promise<Result<PeerSessionLease, FleetError>> {
      acquisitions.push(peerId)
      if (nextFailure) {
        const failure = nextFailure
        nextFailure = undefined
        return err(failure)
      }
      const lease: PeerSessionLease = {
        sessionId,
        resumed,
        async send(turn: Turn): Promise<TurnId> {
          if (nextSendFailure) {
            const failure = nextSendFailure
            nextSendFailure = undefined
            throw failure
          }
          sent.push({ sessionId, turn })
          return `trn_${String(sent.length).padStart(16, '0')}` as TurnId
        },
      }
      return ok(lease)
    },
  }
}

export interface FakeBriefs extends BriefVersions {
  set(peerId: PeerId, version: number | undefined): void
  readonly calls: readonly PeerId[]
}

export const fakeBriefs = (initial: Readonly<Record<string, number>> = {}): FakeBriefs => {
  const versions = new Map<PeerId, number>(Object.entries(initial) as [PeerId, number][])
  const calls: PeerId[] = []
  return {
    calls,
    set: (peerId, version) => {
      if (version === undefined) versions.delete(peerId)
      else versions.set(peerId, version)
    },
    async current(peerId: PeerId): Promise<number | undefined> {
      calls.push(peerId)
      return versions.get(peerId)
    },
  }
}


/** A peer with no session at all, as the supervisor reports it (§7). */
export const noSession = (peerId: PeerId): FleetError =>
  fleetError('not_found', `${String(peerId)} has no live session`, { details: { peerId } })


/** A session that would not resume (§4, §7). */
export const resumeFailed = (peerId: PeerId): FleetError =>
  fleetError('provider_failed', `${String(peerId)}'s session would not resume`, { details: { peerId } })
