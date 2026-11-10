/**
 * One peer's session, as the supervisor runs it (§2, §8).
 *
 * The wrapper owns the provider's event stream and nothing else: it maps events
 * to peer state, counts turns, and — at a turn boundary, when the policy says
 * the context is spent — runs the self-purge and carries on with the fresh
 * session. It never talks to the model and never reads a transcript.
 *
 * The one subtlety is the purge's ask. The peer is asked for its state file, and
 * the answer only arrives as the *next* `turn.ended` on the stream this loop is
 * already reading — so the pump must keep pumping while the purge waits. The
 * purge therefore runs as a promise the loop never awaits, and the loop
 * resolves its ask from the event stream. When the purge stops the old session,
 * the stream ends, the loop exits, and only then is the purge's outcome
 * collected.
 *
 * Two things follow from that, and are enforced here rather than trusted. No
 * mail is delivered into a session that is being replaced: `deliver` refuses
 * while a purge is in flight, because a turn written into a session about to be
 * stopped is a turn the peer never reads — the mailbox holds the message
 * unacked and replays it into the fresh session (§7, §8). And a purge that
 * cannot bring a session back recovers one: a failing restart used to reject
 * `run()` and leave a peer with no session at all, so `recover` is tried first,
 * and only a recovery that fails too rejects.
 */

import {
  fleetError,
  peerActor,
  type Clock,
  type PeerId,
  type PeerState,
  type SessionId,
  type TurnId,
} from '@fleet/foundation-core'
import type { ProviderEvent, SessionEndReason, StateFile, Usage } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle, Turn } from '@fleet/runtime-provider-sdk'

import { peerStateOf } from './peer-state.ts'
import { purgeTrigger, type PurgeLimits } from './policy.ts'
import { restartStateFileOf, type PurgeOutcome } from './purge.ts'
import { sessionIdOf, type SessionRecord } from './records.ts'
import { emptyToolCalls, withToolCall, type ToolCalls } from './tool-calls.ts'

export type { SessionRecord } from './records.ts'

/**
 * The event schema's own bounds (§4). A provider's `tool.use` summary is
 * already short and redacted, but its contract allows 500 characters and the
 * activity event allows 200; the cut happens here, at the writer, so the store
 * never has to refuse a record the session already thought it made.
 */
const TOOL_MAX = 64
const TARGET_MAX = 200

const bounded = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`

/** What a purge needs from the live session: its handle, its brief, and a way to ask. */
export interface PurgeInput {
  readonly handle: SessionHandle
  readonly briefVersion: number
  /** Send one turn and resolve when it has ended. */
  readonly ask: (text: string) => Promise<void>
}

export interface PeerSessionPorts {
  readonly provider: Provider
  readonly handle: SessionHandle
  readonly peerId: PeerId
  /** The brief version the session was started against; carried into the purge (§7, §12). */
  readonly briefVersion: number
  /** Per provider and model, from `config/policies/limits` (§8). */
  readonly limits: PurgeLimits
  readonly clock: Clock
  /**
   * Append one record. The store's `append` returns `Seq[]`, so this is
   * awaited at every call site: a fire-and-forget append loses records on a
   * crash and can reorder them, and neither is visible until it matters.
   */
  readonly record: (record: SessionRecord) => void | Promise<void>
  /**
   * Run one purge and return with the fresh session. Injected so this file
   * holds the loop and `purge.ts` holds the protocol, and so tests can purge
   * without a provider.
   */
  readonly purge: (input: PurgeInput) => Promise<PurgeOutcome>
  /**
   * Last resort when the pump failed: start a session from role + the current
   * brief. `stateFile` is the handoff a purge had already written and recorded
   * when its restart failed, and the recovered session must be started from it
   * with newer mail replayed (§8); it is `undefined` when there was no purge to
   * hand off, so the session starts from role and brief alone. It receives the
   * failure so the caller can record why. A recovery that fails too propagates
   * — a peer with no session must be visible, not silently idle.
   */
  readonly recover: (
    from: SessionHandle,
    failure: unknown,
    stateFile: StateFile | undefined,
  ) => Promise<SessionHandle>
  /**
   * What re-sending `preTokens` of context cost, at this model's configured
   * price (§11); `undefined` when the profile prices nothing, which the event
   * records as absent rather than as zero. It is injected because a price is
   * configuration and the supervisor is not the place configuration lives, and
   * because a test that asserts a bill should hand it its own arithmetic.
   */
  readonly estimateCompactionCost?: (preTokens: number) => number | undefined
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

/** One question or approval waiting for a person, and whose it is (§8). */
interface PendingOwner {
  readonly turnId: TurnId
  readonly sessionId: SessionId
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * A peer's session. `run()` resolves when the session is over for good — ended
 * by the provider, stopped by the fleet, or replaced by a purge whose own
 * session then ended. A purge that fails is recovered by `recover`; a
 * `recover` that fails too rejects `run()`: a peer without a session must be
 * visible, not silently idle.
 */
export class PeerSession {
  readonly #ports: PeerSessionPorts
  #handle: SessionHandle
  #state: PeerState = 'starting'
  #stopped = false
  /** True from the moment a purge is triggered until a session is running again. */
  #purging = false
  /** Tool calls per *open* turn, dropped when the turn ends (§6.2). */
  readonly #toolCalls = new Map<TurnId, ToolCalls>()
  /**
   * The turn that ended most recently, with the exploration it spent. One slot
   * is enough: the boundary is judged by the same iteration that applied the
   * event, before the next event is read.
   */
  #endedTurn: { readonly turnId: TurnId; readonly toolCalls: ToolCalls } | undefined
  /**
   * Turns started and not yet ended, each with the session that raised it: a
   * purge boundary is not one while work is open, and the work only counts
   * against the session it belongs to (§8).
   */
  readonly #openTurns = new Map<TurnId, SessionId>()
  /**
   * The questions and approvals waiting for a person, each with the turn and
   * the session that raised it. The answer never appears on the event stream —
   * the fleet delivers it through `answer()`/`respond()` — so the only proof
   * that one was answered is its turn ending: a turn cannot end while its own
   * question is still open, so `turn.ended` clears that turn's entries before
   * the boundary is judged.
   *
   * A `turn.started` is not an answer (the answer unblocks the *same* turn, and
   * an idle peer over its limit would then never be purged again) and neither
   * is a new stream: a question outliving its session is nobody's to answer, so
   * it is abandoned at the session's end rather than inherited by its
   * replacement.
   */
  readonly #pending = new Map<string, PendingOwner>()
  /**
   * Set once the bookkeeping invariant has been recorded, so `run()` reports it
   * instead of recovering into a fresh session that hides it (§8).
   */
  #faulted = false

  constructor(ports: PeerSessionPorts) {
    this.#ports = ports
    this.#handle = ports.handle
  }

  get handle(): SessionHandle {
    return this.#handle
  }

  get state(): PeerState {
    return this.#state
  }

  /**
   * Hand one turn to the peer — the way mail reaches a session (§7).
   *
   * Refused while a purge is replacing the session: the old one is about to be
   * stopped and a turn written into it is never read. The refusal is typed
   * `conflict` so the caller keeps the message in the mailbox, where it is
   * replayed into the fresh session instead of lost.
   */
  async deliver(turn: Turn): Promise<TurnId> {
    if (this.#purging) {
      throw fleetError(
        'conflict',
        `peer ${this.#ports.peerId} is being purged; the message must wait in the mailbox`,
        { details: { peerId: this.#ports.peerId, sessionId: this.#handle.sessionId } },
      )
    }
    return this.#ports.provider.send(this.#handle, turn)
  }

  /** Stop the session deliberately: no restart, no purge. */
  async stop(): Promise<void> {
    this.#stopped = true
    await this.#ports.provider.stop(this.#handle)
  }

  async run(): Promise<void> {
    let handle = this.#handle
    // One recovery, not a restart loop: a peer that is recovered and then fails
    // again has a failure to report, not a session to keep starting. A purge
    // that succeeds puts the peer on a fresh session, which resets it.
    let recovered = false
    for (;;) {
      let purged: PurgeOutcome | undefined
      try {
        purged = await this.#pump(handle)
      } catch (failure) {
        // A deliberate stop is not a failure to recover from. Nor is a broken
        // invariant: a recovery would start a clean session over the top of it
        // and the violation would be gone from everything a person can read
        // (§8). It was recorded before it was thrown, so stopping is visible.
        if (this.#stopped || recovered || this.#faulted) throw failure
        recovered = true
        handle = await this.#ports.recover(handle, failure, restartStateFileOf(failure))
        this.#handle = handle
        this.#purging = false
        continue
      }
      if (purged === undefined || this.#stopped) return
      handle = purged.handle
      this.#handle = handle
      this.#purging = false
      recovered = false
    }
  }

  /**
   * Read one session's stream to its end.
   *
   * Returns the purge outcome when this session was replaced by a purge, so the
   * caller can keep going on the new handle; `undefined` when it ended.
   */
  async #pump(handle: SessionHandle): Promise<PurgeOutcome | undefined> {
    const { clock, limits, provider } = this.#ports
    const sessionId = sessionIdOf(handle)
    const startedAt = clock.millis()
    // Nothing is reset here. A new stream starts owning nothing because the
    // session it replaces abandoned what it owned when it ended, and a leftover
    // is caught at the next boundary rather than quietly cleared: wiping the
    // count was how a dead session's open turn silently stopped its
    // replacement ever being purged, and how a dead session's question kept a
    // live peer waiting on a person who had already been replaced.
    let turns = 0
    let askWaiter: Deferred<void> | undefined
    let purge: Promise<PurgeOutcome> | undefined

    const ask = (text: string): Promise<void> => {
      const waiter = deferred<void>()
      askWaiter = waiter
      // A send that fails must not leave the purge waiting for a turn that will
      // never start: the ask resolves either way and the validity of the state
      // file decides what happens next.
      void provider
        .send(handle, { text, kind: 'nudge', briefVersion: this.#ports.briefVersion })
        .catch(() => waiter.resolve())
      return waiter.promise
    }

    let failed: unknown
    try {
      for await (const event of provider.events(handle)) {
        await this.#apply(handle, event, purge !== undefined)

        if (event.type === 'session.ended') break
        if (event.type !== 'turn.ended') continue

        // A turn boundary reached *during* a purge is the peer answering the ask.
        if (askWaiter !== undefined) {
          const waiter = askWaiter
          askWaiter = undefined
          waiter.resolve()
          continue
        }
        if (event.reason !== 'completed' || purge !== undefined) continue

        // Everything still open at this boundary must be this session's, and a
        // boundary with somebody else's is a fault, not a `continue`. It used
        // to be skipped in silence, which left the peer permanently
        // un-purgeable — and left a person waiting on a question whose session
        // had already died (§8, §13). Checked before the boundary is judged.
        await this.#assertOnlyOwnedBy(sessionId)

        // A turn boundary is a purge boundary only while the peer is idle and
        // nothing is owed to a person. A question still open, or a turn that
        // started before this one ended, is not one: the purge would interrupt
        // the peer and then read the ask's own end as the peer's answer.
        if (this.#state !== 'idle' || this.#pending.size > 0 || this.#openTurns.size > 0) continue

        turns += 1
        const usage = await provider.usage(handle)
        // §6.2's measurement, at the boundary the fleet already owns: the same
        // `usage()` the purge reads, plus what the turn spent. Recorded before
        // the trigger is judged, so a turn that causes a purge has still been
        // counted — the handoff costs tokens too.
        await this.#recordUsage(handle, event.turnId, usage)
        const trigger = purgeTrigger({
          usage,
          usageTokens: provider.capabilities.usageTokens,
          turns,
          sessionMillis: clock.millis() - startedAt,
          limits,
        })
        if (trigger === undefined) continue

        // Not awaited: the ask it is about to make is answered by this very loop.
        // No mail goes into the session from here until a replacement is running.
        this.#purging = true
        purge = this.#ports.purge({ handle, briefVersion: this.#ports.briefVersion, ask })
        purge.catch(() => {
          // The rejection is collected below, once the stream has ended. Attaching
          // here only keeps Node from calling it an unhandled rejection first.
        })
      }
    } catch (thrown) {
      // The stream itself failed: a provider that throws out of `events()` never
      // gets to synthesise its own `session.ended`. Recorded anyway, because a
      // session the store never saw end is a session a replay reads as live —
      // and this one's handle is dead (§3, §4, §8).
      failed = thrown
    }

    // A session that ends while the purge is waiting for its answer will never
    // deliver that turn. Release the ask so the purge can degrade to facts and
    // restart; waiting here would hang the supervisor with a dead session.
    if (askWaiter !== undefined) {
      const waiter = askWaiter
      askWaiter = undefined
      waiter.resolve()
    }

    if (failed !== undefined) {
      // A broken invariant is not a dead session: the stream may be perfectly
      // healthy and the fleet's bookkeeping is not. Recorded as a fault by
      // `#assertOnlyOwnedBy`, so it leaves here as what it is — a lie in the
      // store, `crashed`, would be worse than no record at all.
      if (this.#faulted) {
        // The pump is stopping for good either way, so the peer is failed and
        // not whatever it was in the middle of (§8).
        await this.#recordPeerState('failed').catch(() => {})
        throw failed
      }
      // A stream that threw never got to synthesise its own `session.ended`, so
      // this session ends here: whatever it still owned is abandoned with it,
      // exactly as a `session.ended` would have done (§8).
      this.#abandonAllOwnedBy(sessionId)
      // State first, then the end, in the order `#apply` writes a real
      // `session.ended`: the store's end projection moves the *session*, it does
      // not move the peer (§4).
      await this.#recordPeerState('failed').catch(() => {})
      // A store that cannot take this record must not swallow the failure that
      // caused it: the caller still has to recover, or report, the dead session.
      await this.#recordEnd(handle, 'crashed').catch(() => {})
      throw failed
    }

    return purge === undefined ? undefined : await purge
  }

  async #apply(handle: SessionHandle, event: ProviderEvent, purging: boolean): Promise<void> {
    const { clock, peerId, record } = this.#ports
    const sessionId = sessionIdOf(handle)

    switch (event.type) {
      case 'turn.started':
        this.#openTurns.set(event.turnId, sessionId)
        break
      case 'tool.use': {
        // A call reported after its turn ended belongs to no boundary that will
        // ever be judged, so it counts nothing — and counting it would keep an
        // entry in `#toolCalls` that nothing clears.
        if (this.#endedTurn?.turnId === event.turnId) break
        this.#toolCalls.set(event.turnId, withToolCall(this.#toolCalls.get(event.turnId) ?? emptyToolCalls, event.tool))
        // What the peer is doing, not only that it is busy (§4). Written here,
        // where the stream says it, so a replay sees the same activity the live
        // fleet showed; the projection keeps the latest and counts the edits.
        await record({
          type: 'peer.tool_used',
          ts: clock.now(),
          subject: peerId,
          actor: peerActor(peerId),
          data: {
            peerId,
            sessionId,
            tool: bounded(event.tool, TOOL_MAX),
            ...(event.summary === undefined ? {} : { target: bounded(event.summary, TARGET_MAX) }),
          },
        })
        break
      }
      case 'turn.ended':
        this.#openTurns.delete(event.turnId)
        // The tally moves out of the open-turn map here, because the map is for
        // turns that are still running and the boundary is judged below.
        this.#endedTurn = { turnId: event.turnId, toolCalls: this.#toolCalls.get(event.turnId) ?? emptyToolCalls }
        this.#toolCalls.delete(event.turnId)
        // This turn cannot end while a question it asked is still open, so its
        // ending is the proof that each of them was answered. Cleared here,
        // before the caller judges the boundary, so the purge can fire at it.
        for (const [id, owner] of this.#pending) {
          if (owner.turnId === event.turnId) this.#pending.delete(id)
        }
        break
      case 'question.asked':
        this.#pending.set(event.questionId, { turnId: event.turnId, sessionId })
        break
      case 'approval.requested':
        this.#pending.set(event.requestId, { turnId: event.turnId, sessionId })
        break
      case 'question.abandoned':
        this.#pending.delete(event.questionId)
        break
      case 'approval.abandoned':
        this.#pending.delete(event.requestId)
        break
      case 'session.ended':
        // The session is over and everything it owned dies with it: an open
        // turn it will never end, and a question or approval no one can answer
        // any more because the session that asked is gone. A replacement
        // re-asks from its state file; it never inherits (§8).
        this.#abandonAllOwnedBy(sessionId)
        break
      case 'compaction':
        // Recorded whether or not a turn is open. An auto-compaction can land
        // between turns and a person's `/compact` always does; both rewrite the
        // peer's context and both cost a bill, and neither has a turn to hang
        // the record on (§8).
        await this.#recordCompaction(handle, event)
        break
      default:
        break
    }

    const next = peerStateOf(event)
    if (next !== undefined && next !== this.#state) {
      this.#state = next
      await record({
        type: 'peer.state_changed',
        ts: clock.now(),
        subject: peerId,
        actor: peerActor(peerId),
        data: { peerId, state: next, sessionId },
      })
    }
    if (event.type === 'session.ended') {
      await this.#recordEnd(handle, endReasonOf(event, purging), event.code)
    }
  }

  /** Drop everything one session owned, because that session is over (§8). */
  #abandonAllOwnedBy(sessionId: SessionId): void {
    for (const [turnId, owner] of this.#openTurns) {
      if (owner === sessionId) this.#openTurns.delete(turnId)
    }
    for (const [id, owner] of this.#pending) {
      if (owner.sessionId === sessionId) this.#pending.delete(id)
    }
  }

  /**
   * The rule the whole class rests on: a turn, a question and an approval
   * belong to the session that raised them, so at a boundary every open one
   * belongs to the session the boundary is on.
   *
   * A foreign entry means a session ended without this loop learning of it —
   * and the boundary used to read that as "still busy" and skip the purge, for
   * every boundary after it, in silence. So it is neither recoverable nor
   * ignorable: the fault goes to the store first (a `provider.errored`, which
   * the store turns into a failure notification and the `notify` routine rings
   * on), and then out of `run()`, which stops this peer's pump because
   * `#faulted` keeps the recovery from papering over it (§8, §13).
   */
  async #assertOnlyOwnedBy(sessionId: SessionId): Promise<void> {
    const orphanedTurns = [...this.#openTurns]
      .filter(([, owner]) => owner !== sessionId)
      .map(([turnId]) => String(turnId))
    const orphanedPending = [...this.#pending]
      .filter(([, owner]) => owner.sessionId !== sessionId)
      .map(([id]) => id)
    if (orphanedTurns.length + orphanedPending.length === 0) return

    const { clock, peerId, record, provider } = this.#ports
    // Recorded before the throw, and a store that refuses the record must not
    // replace the invariant with its own failure: the throw is the signal.
    try {
      await record({
        type: 'provider.errored',
        ts: clock.now(),
        subject: peerId,
        actor: peerActor(peerId),
        data: {
          peerId,
          sessionId,
          providerId: provider.id,
          code: 'invariant',
          message: `peer ${String(peerId)}: session ${String(sessionId)} is holding work another session raised (${[...orphanedTurns, ...orphanedPending].join(', ')})`,
          retryable: false,
        },
      })
    } catch {
      // Nothing to do with a store that would not take it: the throw below is
      // the signal, and swallowing this keeps the store's failure from being
      // mistaken for the invariant violation.
    }

    this.#faulted = true
    throw fleetError(
      'invariant',
      `peer ${String(peerId)}: session ${String(sessionId)} is holding work another session raised — the pump is stopped`,
      {
        details: {
          peerId: String(peerId),
          sessionId: String(sessionId),
          orphanedTurns,
          orphanedPending,
        },
      },
    )
  }

  /**
   * One finished turn, as the store hears about it (§6.2).
   *
   * Two sources, and neither is a guess: the context side is the `usage()` the
   * caller already measured for the purge, and the spend is whatever the
   * provider reported for the turn — which is why a provider without
   * `turnSpend` records nothing rather than a row of zeroes that a report would
   * read as a free turn.
   *
   * The exploration counts come from the stream's own `tool.use` events, not
   * from a transcript: under fleetd there is no hook to read one, and the same
   * source works for every provider.
   */
  async #recordUsage(handle: SessionHandle, turnId: TurnId, usage: Usage): Promise<void> {
    const { clock, peerId, provider, record } = this.#ports
    const spend = provider.turnSpend?.(handle)
    if (spend === undefined) return
    const toolCalls = this.#endedTurn?.turnId === turnId ? this.#endedTurn.toolCalls : emptyToolCalls
    await record({
      type: 'turn.usage_recorded',
      ts: clock.now(),
      subject: peerId,
      actor: peerActor(peerId),
      data: {
        peerId,
        sessionId: sessionIdOf(handle),
        contextTokens: usage.contextTokens,
        contextLimit: usage.contextLimit,
        inputTokens: spend.inputTokens,
        outputTokens: spend.outputTokens,
        cachedTokens: spend.cachedTokens,
        toolCalls,
        ...(spend.costUsd === undefined ? {} : { costUsd: spend.costUsd }),
      },
    })
  }

  /**
   * One compaction, as the store hears about it. The cost is an estimate of the
   * tokens the provider had to read again to summarise, priced by the profile;
   * when nothing prices them the field is left out rather than set to zero,
   * because "not priced here" and "free" are different claims (§8).
   *
   * The configured window is recorded beside the tokens the provider actually
   * compacted at, because that pair is the only way to see from the store that a
   * profile's `contextLimit` is too high for its model: the provider compacted
   * at 40K while the fleet thought it had 200K, so no ratio against 200K would
   * ever have fired. `usage` is asked at compaction time rather than cached,
   * since it is the running session's number and the whole point is to catch it
   * disagreeing with config. A provider that cannot report usage has no window
   * to compare against, and a failing `usage` must not cost the record.
   */
  async #recordCompaction(
    handle: SessionHandle,
    event: Extract<ProviderEvent, { type: 'compaction' }>,
  ): Promise<void> {
    const { clock, peerId, record, provider, estimateCompactionCost } = this.#ports
    const contextLimit = await this.#contextLimit(handle)
    const estimate = estimateCompactionCost?.(event.contextTokensBefore)
    // Rounded to a ten-thousandth of a dollar: raw float arithmetic on a price
    // produces `0.6000000000000001`, which is not a number anybody should read in
    // a notification, and a sub-cent cost still rounds to a nonzero figure.
    const estimated = estimate === undefined ? undefined : Math.round(estimate * 10_000) / 10_000
    await record({
      type: 'peer.compacted',
      ts: clock.now(),
      subject: peerId,
      actor: peerActor(peerId),
      data: {
        peerId,
        trigger: event.trigger,
        preTokens: event.contextTokensBefore,
        ...(event.contextTokensAfter === undefined ? {} : { postTokens: event.contextTokensAfter }),
        ...(contextLimit === undefined ? {} : { contextLimit }),
        ...(estimated === undefined ? {} : { estimatedCostUsd: estimated }),
      },
    })
  }

  /** The window this session is configured with, or `undefined` when it cannot be known (§4, §8). */
  async #contextLimit(handle: SessionHandle): Promise<number | undefined> {
    const { provider } = this.#ports
    if (!provider.capabilities.usageTokens) return undefined
    try {
      return (await provider.usage(handle)).contextLimit
    } catch {
      // A compaction is still news when the usage call fails; the comparison is
      // what is lost, and an absent field says exactly that.
      return undefined
    }
  }

  /**
   * The peer's own state, written when the stream that would have carried it is
   * gone (§4, §8).
   *
   * A provider that ends cleanly sends its own `session.ended`, and `#apply`
   * turns that into a state change like any other event. A stream that throws
   * sends nothing — and a `session.ended` recorded on its behalf does not move
   * the peer either: the store's projection writes the *session's* row and
   * clears its `currentSessionId`, while `peers.state` keeps whatever the last
   * `peer.state_changed` said. A crash with a question open would therefore
   * leave the peer reading `waiting_input` for as long as the store lives, on a
   * question its session took with it — the orphan §8 bans, one layer up where
   * a person actually reads it.
   */
  async #recordPeerState(state: PeerState): Promise<void> {
    if (state === this.#state) return
    this.#state = state
    const { clock, peerId, record } = this.#ports
    await record({
      type: 'peer.state_changed',
      ts: clock.now(),
      subject: peerId,
      actor: peerActor(peerId),
      data: { peerId, state },
    })
  }

  /**
   * One session's end, whichever way it ended: the provider's own `session.ended`
   * or a stream that threw before it could send one. Both are the same event to
   * the store, so both go through here and a reader cannot tell them apart by
   * accident (§3, §4).
   */
  async #recordEnd(handle: SessionHandle, endReason: SessionEndReason, code?: number): Promise<void> {
    const { clock, peerId, record } = this.#ports
    await record({
      type: 'session.ended',
      ts: clock.now(),
      subject: sessionIdOf(handle),
      actor: peerActor(peerId),
      data: {
        peerId,
        sessionId: sessionIdOf(handle),
        endReason,
        ...(code === undefined ? {} : { code }),
      },
    })
  }
}

/**
 * The provider reports only how its stream stopped — `exit`, `crash`, or the
 * `stopped` we asked for — while the store keeps the fleet's six reasons. A
 * clean exit is `completed` and a non-zero one is `failed`; a stop we asked for
 * during a purge is the purge's own restart (§8), not a session that ended.
 */
const endReasonOf = (
  event: Extract<ProviderEvent, { type: 'session.ended' }>,
  purging: boolean,
): SessionEndReason => {
  if (event.reason === 'crash') return 'crashed'
  if (event.reason === 'stopped') return purging ? 'purged' : 'stopped'
  return event.code === undefined || event.code === 0 ? 'completed' : 'failed'
}
