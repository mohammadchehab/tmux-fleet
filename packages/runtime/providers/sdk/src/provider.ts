/**
 * The Provider interface, verbatim from architecture §4. Providers are the
 * only code that knows a vendor; the interface is small, every method is
 * typed, and no method returns text meant to be parsed.
 *
 * A provider never imports the store (§1.1): the supervisor adapts these
 * events into stored events.
 */

import type { PeerState, TurnId } from '@fleet/foundation-core'
import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderHandle,
  ProviderSessionRef,
  SessionSpec,
  Turn,
  Usage,
} from '@fleet/foundation-contracts'

export type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderHandle,
  ProviderSessionRef,
  SessionSpec,
  Turn,
  Usage,
}

/**
 * An open session. Opaque to everything outside the provider: the supervisor
 * holds it, the store holds a `SessionId`, and no caller ever sees the vendor's
 * session ref except through `sessionRef` for `resume` (§7, §13).
 */
export interface SessionHandle {
  readonly sessionId: string
  /** The vendor's reference, for `resume` after a crash or a purge (§7, §8). */
  readonly sessionRef: ProviderSessionRef
  readonly peerId: string
  readonly providerId: string
  /** The model the *process* is actually running, as `model()` reports it (§4). */
  readonly model: string
  readonly permissionMode: string
}

/**
 * §4, unchanged:
 *
 * ```ts
 * start(spec) / send(h, turn) / interrupt(h, turn?) / stop(h) / status(h) /
 * usage(h) / model(h) / events(h) / resume(ref, spec)
 * ```
 *
 * `resume` is optional in the type system only because `capabilities.resume`
 * says whether it is real: a provider that cannot resume declares
 * `resume: false` and the supervisor starts fresh instead (§4, §16).
 */
export interface Provider extends ProviderHandle {
  readonly id: string
  readonly capabilities: ProviderCapabilities

  /** Start a session from a spec: cwd, env, model, permission mode, role brief, resume ref. */
  start(spec: SessionSpec): Promise<SessionHandle>

  /** A turn, never keystrokes — so delivery works for every provider (§7). */
  send(handle: SessionHandle, turn: Turn): Promise<TurnId>

  /** Stop the current turn (or one turn), leaving the session usable. */
  interrupt(handle: SessionHandle, turn?: TurnId): Promise<void>

  stop(handle: SessionHandle): Promise<void>

  status(handle: SessionHandle): Promise<PeerState>

  /** Context tokens against the model's limit; the self-purge trigger (§8). */
  usage(handle: SessionHandle): Promise<Usage>

  /** Read from the spawned process or SDK config, never from a UI string (§4, §13). */
  model(handle: SessionHandle): Promise<{ id: string; endpoint?: string }>

  /** Turn started/ended, tool use, question asked, error, compaction (§4). */
  events(handle: SessionHandle): AsyncIterable<ProviderEvent>

  /** Resume a session from a vendor ref. Present when `capabilities.resume` is true. */
  resume(ref: ProviderSessionRef, spec: SessionSpec): Promise<SessionHandle>
}

/**
 * A provider that cannot resume declares it once and `resume` is then a
 * programming error rather than a silent fresh start (§4, §16).
 */
export type ProviderWithResume = Provider & { readonly capabilities: ProviderCapabilities & { resume: true } }
