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
  QuestionAnswer,
  SessionSpec,
  Turn,
  Usage,
} from '@fleet/foundation-contracts'
import type { QuestionId } from '@fleet/foundation-core'

/** The two answers an approval takes. Anything else is the human's job, not the inbox's. */
export type ApprovalDecision = 'allow' | 'deny'

export type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderHandle,
  ProviderQuestion,
  ProviderSessionRef,
  QuestionAnswer,
  SessionSpec,
  Turn,
  TurnEndReason,
  Usage,
} from '@fleet/foundation-contracts'

export type { QuestionId } from '@fleet/foundation-core'

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
  /**
   * The turn the brief was delivered as. Some providers say nothing until a
   * first user message arrives, so `start()` sends the brief as a real turn and
   * the first `turn.started` event refers to this id (§4, §7).
   */
  readonly briefTurnId: TurnId
}

/**
 * One turn's spend, as the provider measured it (§6.2): the counters
 * `turn.usage_recorded` carries, minus the identity and the context side, which
 * are the supervisor's to fill in from `usage()`.
 */
export interface TurnSpend {
  /** Fresh input tokens: not what was read from, or written to, the cache. */
  readonly inputTokens: number
  /** Output tokens, thinking included where the provider counts it there. */
  readonly outputTokens: number
  /** Tokens read out of the prompt cache. */
  readonly cachedTokens: number
  /** The turn's own cost, from the provider's pricing; absent when it prices nothing. */
  readonly costUsd?: number
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

  /**
   * Resolve a pending `question.asked`. The id comes from the event, never from
   * the answer: an event is stored and replayed, so it cannot carry one (§4).
   * Rejects `FleetError('not_found')` when nothing is pending under that id —
   * the session died, or the answer was already delivered.
   */
  answer(handle: SessionHandle, questionId: QuestionId, answer: QuestionAnswer): Promise<void>

  /**
   * Resolve a pending `approval.requested`. In `bypassPermissions` no approval
   * is ever asked (the SDK auto-approves and never consults its callback), so a
   * `respond` there is the same `not_found` (§4, §13).
   */
  respond(handle: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void>

  stop(handle: SessionHandle): Promise<void>

  status(handle: SessionHandle): Promise<PeerState>

  /** Context tokens against the model's limit; the self-purge trigger (§8). */
  usage(handle: SessionHandle): Promise<Usage>

  /**
   * What the turn that just ended spent (§6.2), for `turn.usage_recorded`.
   *
   * The other half of `usage()`: that one answers how full the context is, this
   * one what the turn cost. It is answered from what the stream already said at
   * the boundary — no control call, so it still answers for a session whose CLI
   * has just exited, and it counts **subagents and sidechains** where the
   * provider's boundary message reports them (`result.modelUsage` does), which
   * is what a transcript reader cannot see.
   *
   * Optional: a provider that counts no tokens leaves it out, and the supervisor
   * records no usage rather than a row of zeroes that reads as a cheap turn.
   */
  turnSpend?(handle: SessionHandle): TurnSpend | undefined

  /**
   * The window this provider is configured to assume for `model` (§8), known
   * without a session — which is why it sits here rather than on `usage()`.
   *
   * §6.2's Stop hook measures a turn from the transcript and compares it against
   * a limit it must not guess, and a session's env is built *before* the session
   * exists. So the number has to be answerable from provider config, and it is
   * the same number `usage()` reports: one configured window, two readers.
   *
   * Optional, and `undefined` is a real answer: a provider with no configured
   * window (or a model it does not know) leaves the variable out of the
   * session's env, and the hook skips with its reason rather than reporting
   * against a made-up limit.
   */
  contextLimit?(model: string): number | undefined

  /** Read from the spawned process or SDK config, never from a UI string (§4, §13). */
  model(handle: SessionHandle): Promise<{ id: string; endpoint?: string }>

  /** Turn started/ended{reason}, tool use, questions, approvals, session end, error, compaction (§4). */
  events(handle: SessionHandle): AsyncIterable<ProviderEvent>

  /**
   * Change the model of a live session. Always callable, like `resume()`:
   * when `capabilities.modelSwitch` is false it rejects `FleetError('unsupported')`.
   * Confirmation may arrive one turn late (the new model shows in the next init
   * the provider reports), so the supervisor treats a switch it has not seen
   * confirmed as pending, not failed; `model()` then reports the requested model
   * and `config_mismatch` is judged against it, not the one the session left (§4).
   */
  setModel(handle: SessionHandle, model: string): Promise<void>

  /** Resume a session from a vendor ref. Present when `capabilities.resume` is true. */
  resume(ref: ProviderSessionRef, spec: SessionSpec): Promise<SessionHandle>
}

/**
 * A provider that cannot resume declares it once and `resume` is then a
 * programming error rather than a silent fresh start (§4, §16).
 */
export type ProviderWithResume = Provider & { readonly capabilities: ProviderCapabilities & { resume: true } }
