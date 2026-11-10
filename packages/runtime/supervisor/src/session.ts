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

import { fleetError, type Clock, type PeerId, type PeerState, type TurnId } from '@fleet/foundation-core'
import type { ProviderEvent } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle, Turn } from '@fleet/runtime-provider-sdk'

import { peerStateOf } from './peer-state.ts'
import { purgeTrigger, type PurgeLimits } from './policy.ts'
import type { PurgeEvent, PurgeOutcome } from './purge.ts'

/** What the supervisor records about a session; the store assigns `seq` and `ts` (§3). */
export type SessionRecord =
  | { readonly type: 'peer.state'; readonly peerId: PeerId; readonly sessionId: string; readonly state: PeerState }
  | {
      readonly type: 'session.ended'
      readonly peerId: PeerId
      readonly sessionId: string
      /** `purged` is the self-purge restart (§8), not a failure. */
      readonly reason: 'exit' | 'crash' | 'stopped' | 'purged'
      readonly code?: number
    }
  | PurgeEvent

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
   * Last resort when the pump failed and the purge could not restart: start a
   * session from role + the current brief, with no state file and no replay.
   * It receives the failure so the caller can record why. A recovery that
   * fails too propagates — a peer with no session must be visible, not
   * silently idle.
   */
  readonly recover: (from: SessionHandle, failure: unknown) => Promise<SessionHandle>
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
   * A question or approval is waiting for a person. The answer never appears on
   * the event stream — the fleet delivers it through `answer()`/`respond()` — so
   * it clears when the next turn starts, not when it is answered: a purge put
   * off by one turn costs nothing, and purging a peer that is waiting on a human
   * interrupts the one thing it cannot re-do.
   */
  #pendingInput = false

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
        handle = await this.#ports.recover(handle, failure)
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
    // A new stream starts with nothing open: turns and questions belong to the
    // session that raised them, and a dead session's open turn must not block
    // every later purge boundary on its replacement.
    this.#openTurns = 0
    this.#pendingInput = false
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
      if (this.#state !== 'idle' || this.#pendingInput || this.#openTurns > 0) continue

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

    // A session that ends while the purge is waiting for its answer will never
    // deliver that turn. Release the ask so the purge can degrade to facts and
    // restart; waiting here would hang the supervisor with a dead session.
    if (askWaiter !== undefined) {
      const waiter = askWaiter
      askWaiter = undefined
      waiter.resolve()
    }

    return purge === undefined ? undefined : await purge
  }

  async #apply(handle: SessionHandle, event: ProviderEvent, purging: boolean): Promise<void> {
    const { peerId, record } = this.#ports

    switch (event.type) {
      case 'turn.started':
        this.#openTurns += 1
        // A turn that starts after a question means the question was answered.
        this.#pendingInput = false
        break
      case 'turn.ended':
        this.#openTurns = Math.max(0, this.#openTurns - 1)
        break
      case 'question.asked':
      case 'approval.requested':
        this.#pendingInput = true
        break
      case 'question.abandoned':
        this.#pendingInput = false
        break
      default:
        break
    }

    const next = peerStateOf(event)
    if (next !== undefined && next !== this.#state) {
      this.#state = next
      await record({ type: 'peer.state', peerId, sessionId: handle.sessionId, state: next })
    }
    if (event.type === 'session.ended') {
      await record({
        type: 'session.ended',
        peerId,
        sessionId: handle.sessionId,
        reason: purging && event.reason === 'stopped' ? 'purged' : event.reason,
        ...(event.code === undefined ? {} : { code: event.code }),
      })
    }
  }
}
