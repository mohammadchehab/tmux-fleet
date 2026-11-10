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
  type TurnId,
} from '@fleet/foundation-core'
import type { ProviderEvent, SessionEndReason, StateFile } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle, Turn } from '@fleet/runtime-provider-sdk'

import { peerStateOf } from './peer-state.ts'
import { purgeTrigger, type PurgeLimits } from './policy.ts'
import { restartStateFileOf, type PurgeOutcome } from './purge.ts'
import { sessionIdOf, type SessionRecord } from './records.ts'

export type { SessionRecord } from './records.ts'

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
  /** Turns started and not yet ended: a purge boundary is not one while work is open. */
  #openTurns = 0
  /**
   * The questions and approvals waiting for a person, each with the turn that
   * raised it. The answer never appears on the event stream — the fleet
   * delivers it through `answer()`/`respond()` — so the only proof that one was
   * answered is its turn ending: a turn cannot end while its own question is
   * still open, so `turn.ended` clears that turn's entries before the boundary
   * is judged.
   *
   * Two things do not clear it. A `turn.started` is not an answer (the answer
   * unblocks the *same* turn, and an idle peer over its limit would then never
   * be purged again), and neither is a new stream (a question asked on a
   * session that then died is still a person being waited on). Only an end of
   * its turn, or `question.abandoned` — the question died with its session.
   */
  readonly #pending = new Map<string, TurnId>()

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
        // A deliberate stop is not a failure to recover from.
        if (this.#stopped || recovered) throw failure
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
    const startedAt = clock.millis()
    // A new stream starts with no turn open: turns belong to the session that
    // raised them, and a dead session's open turn must not block every later
    // purge boundary on its replacement. A pending question is *not* reset with
    // them — the person it is waiting on has not been answered by a restart.
    this.#openTurns = 0
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

        // A turn boundary is a purge boundary only while the peer is idle and
        // nothing is owed to a person. A question still open, or a turn that
        // started before this one ended, is not one: the purge would interrupt
        // the peer and then read the ask's own end as the peer's answer.
        if (this.#state !== 'idle' || this.#pending.size > 0 || this.#openTurns > 0) continue

        turns += 1
        const usage = await provider.usage(handle)
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
        this.#openTurns += 1
        break
      case 'turn.ended':
        this.#openTurns = Math.max(0, this.#openTurns - 1)
        // This turn cannot end while a question it asked is still open, so its
        // ending is the proof that each of them was answered. Cleared here,
        // before the caller judges the boundary, so the purge can fire at it.
        for (const [id, turnId] of this.#pending) {
          if (turnId === event.turnId) this.#pending.delete(id)
        }
        break
      case 'question.asked':
        this.#pending.set(event.questionId, event.turnId)
        break
      case 'approval.requested':
        this.#pending.set(event.requestId, event.turnId)
        break
      case 'question.abandoned':
        this.#pending.delete(event.questionId)
        break
      case 'compaction':
        // Recorded whether or not a turn is open. An auto-compaction can land
        // between turns and a person's `/compact` always does; both rewrite the
        // peer's context and both cost a bill, and neither has a turn to hang
        // the record on (§8).
        await this.#recordCompaction(event)
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

  /**
   * One compaction, as the store hears about it. The cost is an estimate of the
   * tokens the provider had to read again to summarise, priced by the profile;
   * when nothing prices them the field is left out rather than set to zero,
   * because "not priced here" and "free" are different claims (§8).
   */
  async #recordCompaction(event: Extract<ProviderEvent, { type: 'compaction' }>): Promise<void> {
    const { clock, peerId, record, estimateCompactionCost } = this.#ports
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
        ...(estimated === undefined ? {} : { estimatedCostUsd: estimated }),
      },
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
