/**
 * `@fleet/runtime-provider-claude`: the Claude Agent SDK behind architecture
 * §4's `Provider` interface.
 *
 * There is very little here on purpose. Everything that knows the SDK lives in
 * `session.ts`; this class is the registry-facing surface — capabilities, the
 * session table, and the methods §4 declares. A second SDK-backed provider
 * (DeepInfra is the same SDK with a different base URL) shares all of this and
 * differs only in its config, which is why the config is injected.
 *
 * What the spike proved about this provider, and what each capability rests on
 * (`docs/design/spikes/agent-sdk.md`, §4 of the design):
 *
 * | capability        | why it is true                                                             |
 * |-------------------|----------------------------------------------------------------------------|
 * | `resume`          | `Options.resume = <session id>` reloads the history across processes, same id |
 * | `modelSwitch`     | `query.setModel()` on a live streaming-input session                        |
 * | `usageTokens`     | `getContextUsage({detail})` reports real context tokens                     |
 * | `usageCost`       | `result.total_cost_usd` is priced by the vendor that ran the turn           |
 * | `structuredOutput`| a schema-constrained call (`outputFormat`) answers against a schema          |
 * | `permissionModes` | all four echo back on `init`, and can be changed mid-session                 |
 *
 * One interaction the table does not show: `waiting_input` is only reachable in
 * a mode that asks. `bypassPermissions` shadows `canUseTool`, so a peer in that
 * mode cannot ask its supervisor anything (`session.ts`).
 *
 * `capabilities.usageCost` is the one source of truth for cost reporting: the
 * session reads it through its config, so a provider that says `false` cannot
 * still report a number the ledger would record (§4, §11).
 */

import { fleetError, toFleetError, type PeerState, type TurnId } from '@fleet/foundation-core'
import type {
  ApprovalDecision,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderSessionRef,
  QuestionAnswer,
  QuestionId,
  SessionHandle,
  SessionSpec,
  Turn,
  Usage,
} from '@fleet/runtime-provider-sdk'

import { openingMessage } from './brief.ts'
import { ClaudeSession, defaultSessionConfig, type ClaudeSessionConfig } from './session.ts'
import { contextLimitFor } from './usage.ts'

export interface ClaudeProviderConfig extends Omit<Partial<ClaudeSessionConfig>, 'usageCost'> {
  /** Defaults to `claude`. The DeepInfra provider sets `deepinfra` and passes its own limits. */
  readonly id?: string
  /**
   * Overrides for `claudeCapabilities`. A capability is a promise the supervisor
   * plans around, so a provider states what it can actually do: DeepInfra says
   * `usageCost: false`, and a provider whose SDK cannot resume says
   * `resume: false`. An override the adapter would contradict by doing the thing
   * anyway is rejected at the call, not quietly honoured (see `setModel`, `start`).
   *
   * `usageCost` is not overridable in the session config for the same reason: it
   * comes from here, so the capability and the behaviour cannot disagree.
   */
  readonly capabilities?: Partial<ProviderCapabilities>
}

/** What the Agent SDK can do, measured in the spike (`docs/design/spikes/agent-sdk.md`). */
export const claudeCapabilities: ProviderCapabilities = Object.freeze({
  resume: true,
  modelSwitch: true,
  usageTokens: true,
  usageCost: true,
  structuredOutput: true,
  permissionModes: Object.freeze([
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
  ] as const satisfies ProviderCapabilities['permissionModes']),
})

export class ClaudeProvider implements Provider {
  readonly id: string
  /**
   * Defaults to `claudeCapabilities`, all true. Only a config that has evidence
   * for a `false` should narrow one — and then the matching method rejects
   * `unsupported` rather than performing the capability it just disclaimed, so
   * the two can never disagree.
   */
  readonly capabilities: ProviderCapabilities

  readonly #config: ClaudeSessionConfig
  readonly #sessions = new Map<string, ClaudeSession>()

  constructor(config: ClaudeProviderConfig = {}) {
    const { id, capabilities, ...sessionConfig } = config
    this.id = id ?? 'claude'
    this.capabilities = Object.freeze({
      ...claudeCapabilities,
      ...capabilities,
      permissionModes: Object.freeze(capabilities?.permissionModes ?? claudeCapabilities.permissionModes),
    })
    this.#config = {
      ...defaultSessionConfig,
      ...sessionConfig,
      providerId: this.id,
      // From the capability, never from the config: see `ClaudeProviderConfig`.
      usageCost: this.capabilities.usageCost,
    }
  }

  /**
   * Start a session from a spec. A `resumeRef` in the spec is honoured here (§7),
   * and refused up front when `capabilities.resume` is false — a provider that
   * cannot resume must not half-resume.
   *
   * Rejects `config_mismatch` / `permission_mode_mismatch` when the session comes
   * up as something other than the spec asked for, and stops it first: the
   * supervisor restarts rather than tolerating a session in the wrong mode (§13).
   */
  async start(spec: SessionSpec): Promise<SessionHandle> {
    if (!this.capabilities.resume && spec.resumeRef !== undefined) {
      throw fleetError('unsupported', `provider ${this.id} cannot resume, but the spec carries a resumeRef`, {
        details: { providerId: this.id, resumeRef: spec.resumeRef },
      })
    }
    const session = new ClaudeSession(spec, this.#config, spec.resumeRef)
    this.#sessions.set(session.sessionId, session)
    try {
      await session.start(openingMessage(spec))
      return session
    } catch (thrown) {
      await session.stop().catch(() => undefined)
      this.#sessions.delete(session.sessionId)
      throw toFleetError(thrown, 'provider_failed')
    }
  }

  /** Resume from a vendor ref: `start` with the ref handed to the SDK (§7). */
  async resume(ref: ProviderSessionRef, spec: SessionSpec): Promise<SessionHandle> {
    return this.start({ ...spec, resumeRef: ref })
  }

  async send(handle: SessionHandle, turn: Turn): Promise<TurnId> {
    return this.#session(handle).send(turn)
  }

  async interrupt(handle: SessionHandle, turn?: TurnId): Promise<void> {
    return this.#session(handle).interrupt(turn)
  }

  async stop(handle: SessionHandle): Promise<void> {
    const session = this.#session(handle)
    try {
      await session.stop()
    } finally {
      this.#sessions.delete(session.sessionId)
    }
  }

  async status(handle: SessionHandle): Promise<PeerState> {
    return this.#session(handle).status()
  }

  async usage(handle: SessionHandle): Promise<Usage> {
    return this.#session(handle).usage()
  }

  /**
   * The configured window for `model`, without a session (§8, §6.2).
   *
   * `contextLimitFor` throws for a model this config does not cover, which is
   * right for `usage()` — a session that cannot say how full it is must not
   * report the number anyway — but wrong here, where the caller's question is
   * "what should the hook be told?" and "nothing" is a legitimate answer.
   */
  contextLimit(model: string): number | undefined {
    try {
      return contextLimitFor(this.#config.limits, model)
    } catch {
      return undefined
    }
  }

  async model(handle: SessionHandle): Promise<{ id: string; endpoint?: string }> {
    const session = this.#session(handle)
    const endpoint = session.endpoint
    return endpoint === undefined ? { id: session.model } : { id: session.model, endpoint }
  }

  events(handle: SessionHandle): AsyncIterable<ProviderEvent> {
    return this.#session(handle).events()
  }

  /**
   * Answer a pending `question.asked` by the id it carried (§4). The answer is
   * the contract's `QuestionAnswer` — one label per question, in order — so a
   * multi-question ask is answered as a unit rather than one text blob.
   */
  async answer(handle: SessionHandle, questionId: QuestionId, answer: QuestionAnswer): Promise<void> {
    this.#session(handle).answer(questionId, answer)
  }

  /** Allow or deny a tool call blocked on a person, by the id its event carried (§4). */
  async respond(handle: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void> {
    this.#session(handle).respond(requestId, decision)
  }

  /** What the peer is blocked on, with the ids `answer()` and `respond()` take. */
  pending(handle: SessionHandle): ReturnType<ClaudeSession['pending']> {
    return this.#session(handle).pending()
  }

  /**
   * Change the model on a live session (`capabilities.modelSwitch`, §4). The
   * method is always present, like `resume()`; a provider that cannot switch
   * says so in `capabilities` and rejects rather than lying by no-op.
   */
  async setModel(handle: SessionHandle, model: string): Promise<void> {
    if (!this.capabilities.modelSwitch) {
      throw fleetError('unsupported', `provider ${this.id} cannot switch model on a live session`, {
        details: { providerId: this.id, model },
      })
    }
    return this.#session(handle).setModel(model)
  }

  #session(handle: SessionHandle): ClaudeSession {
    const session = this.#sessions.get(handle.sessionId)
    if (session === undefined) {
      throw fleetError('not_found', `no session ${handle.sessionId} in provider ${this.id}`, {
        details: { providerId: this.id, open: [...this.#sessions.keys()] },
      })
    }
    return session
  }
}
