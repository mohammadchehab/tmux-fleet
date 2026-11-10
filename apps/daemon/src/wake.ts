/**
 * Append → wake (§2, §5.2). The store's own writes are the fleet's clock: every
 * committed batch wakes whatever listens for those events, once per event, in
 * seq order, and only after the transaction that wrote them has committed.
 *
 * It lives here rather than in the store because the store is an append-only log
 * and knows nothing about routines or mailboxes (§1.1); the daemon is the one
 * place that knows both. It wakes *after* the commit because a routine that read
 * its own event back out of the log mid-transaction would be reading a log that
 * could still roll back — §5.2's wake has to be a fact about the log, not about
 * an intention to write to it.
 *
 * A wake that throws does not fail the append. The event is already committed and
 * durable; the routines listening for it did not run, which is a gap to report,
 * not a reason to tell the caller its write failed. Reporting one is the
 * injected `onError`'s job — the same place `fleetd` logs everything else.
 */

import type { PeerId, Seq } from '@fleet/foundation-core'
import type { AppendEvent, EventSink, FleetEvent, Mailbox } from '@fleet/foundation-contracts'

/** What reads back the events a batch just wrote, so the wake sees the seqs the store assigned. */
export type ReadCommitted = (from: Seq, limit: number) => Promise<readonly FleetEvent[]>

/** Someone who hears every committed event, in order, after the scheduler has woken. */
export type CommittedListener = (event: FleetEvent) => Promise<void>

/**
 * §7's delivery trigger: a peer that reaches running gets what is waiting for it.
 *
 * `send` hands a message over immediately and leaves it `pending` when the peer has
 * no session, so this is the retry that makes a queue a queue — and it fires on
 * resume too, because a resume arrives as another `session.started`.
 *
 * Delivering for a peer that is *already* being delivered is skipped on purpose.
 * A delivery can itself produce a `session.started`: a supervisor whose `acquire`
 * resumes starts a session, and that append wakes this listener. Awaiting a second
 * `deliver` from there would wait on the Mailbox's per-peer serialization, which is
 * waiting for the first delivery to finish — a hang, not an error. It would also be
 * redundant: the delivery in flight is handing over everything that is pending.
 */
export const deliverOnSessionStart = (mailbox: Pick<Mailbox, 'deliver'>): CommittedListener => {
  const delivering = new Set<PeerId>()

  return async (event) => {
    if (event.type !== 'session.started') return
    const peerId = event.data.peerId
    if (delivering.has(peerId)) return
    delivering.add(peerId)
    try {
      const delivered = await mailbox.deliver(peerId)
      // Thrown so it lands in the sink's `onError`, the one place a failed wake is
      // reported; a delivery that did not happen is not a reason to lose the event.
      if (!delivered.ok) throw delivered.error
    } finally {
      delivering.delete(peerId)
    }
  }
}

export interface WakingSinkDeps {
  /** The store's own append, unwrapped: this is what actually writes. */
  readonly append: EventSink['append']
  readonly read: ReadCommitted
  /**
   * Late-bound on purpose. The sink is what the Mailbox, the supervisor and the
   * API append through, and the scheduler is built from those — so it does not
   * exist yet when the sink does. `undefined` means "not started": an append
   * before `up` is committed and not woken, which is what a stopped daemon does.
   */
  readonly scheduler: () => { wake(event: FleetEvent): Promise<unknown> } | undefined
  /** A wake or a listener failed. Called with the event, never thrown. */
  readonly onError?: (error: unknown, event: FleetEvent) => void
}

export interface WakingSink extends EventSink {
  /**
   * Hear every committed event after the scheduler has. In registration order,
   * so a listener added later cannot see an event before one added earlier.
   */
  listen(listener: CommittedListener): void
}

export const createWakingSink = (deps: WakingSinkDeps): WakingSink => {
  const listeners: CommittedListener[] = []

  const report = (error: unknown, event: FleetEvent): void => {
    // Nothing else to do with it: the append already succeeded, and throwing from a
    // background failure would turn a delivered event into a failed write.
    deps.onError?.(error, event)
  }

  const wakeOne = async (event: FleetEvent): Promise<void> => {
    const scheduler = deps.scheduler()
    if (scheduler === undefined) return
    try {
      await scheduler.wake(event)
    } catch (thrown) {
      report(thrown, event)
      // The scheduler failed before or during its own bookkeeping; the listeners
      // still get the event, because they are not the scheduler's business.
    }
    for (const listener of listeners) {
      try {
        await listener(event)
      } catch (thrown) {
        report(thrown, event)
      }
    }
  }

  return {
    listen(listener) {
      listeners.push(listener)
    },

    async append(batch: readonly AppendEvent[]) {
      const seqs = await deps.append(batch)
      // Read back rather than echoing the batch: a wake has to see the envelope the
      // store assigned — seq included — because that is the event every reader and
      // every replay will see (§5.4). It is also the same shape `rebuild` wakes with.
      const [first] = seqs
      if (first === undefined) return seqs
      const committed = await deps.read(first, seqs.length)
      for (const event of committed) await wakeOne(event)
      return seqs
    },
  }
}
