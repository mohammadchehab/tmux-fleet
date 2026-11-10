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
 */

import type { Clock, PeerId, PeerState } from '@fleet/foundation-core'
import type { ProviderEvent } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle } from '@fleet/runtime-provider-sdk'

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
  readonly record: (record: SessionRecord) => void
  /**
   * Run one purge and return with the fresh session. Injected so this file
   * holds the loop and `purge.ts` holds the protocol, and so tests can purge
   * without a provider.
   */
  readonly purge: (input: PurgeInput) => Promise<PurgeOutcome>
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
 * session then ended. A purge that fails rejects `run()`: a peer without a
 * session must be visible, not silently idle.
 */
export class PeerSession {
  readonly #ports: PeerSessionPorts
  #handle: SessionHandle
  #state: PeerState = 'starting'
  #stopped = false

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

  /** Stop the session deliberately: no restart, no purge. */
  async stop(): Promise<void> {
    this.#stopped = true
    await this.#ports.provider.stop(this.#handle)
  }

  async run(): Promise<void> {
    let handle = this.#handle
    for (;;) {
      const purged = await this.#pump(handle)
      if (purged === undefined || this.#stopped) return
      handle = purged.handle
      this.#handle = handle
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
      this.#apply(handle, event, purge !== undefined)

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

  #apply(handle: SessionHandle, event: ProviderEvent, purging: boolean): void {
    const { peerId, record } = this.#ports
    const next = peerStateOf(event)
    if (next !== undefined && next !== this.#state) {
      this.#state = next
      record({ type: 'peer.state', peerId, sessionId: handle.sessionId, state: next })
    }
    if (event.type === 'session.ended') {
      record({
        type: 'session.ended',
        peerId,
        sessionId: handle.sessionId,
        reason: purging && event.reason === 'stopped' ? 'purged' : event.reason,
        ...(event.code === undefined ? {} : { code: event.code }),
      })
    }
  }
}
