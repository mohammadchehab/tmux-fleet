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
 * | `structuredOutput`| a schema-constrained call (`outputFormat`) answers against a schema          |
 * | `permissionModes` | all four echo back on `init`, and can be changed mid-session                 |
 *
 * One interaction the table does not show: `waiting_input` is only reachable in
 * a mode that asks. `bypassPermissions` shadows `canUseTool`, so a peer in that
 * mode cannot ask its supervisor anything (`session.ts`).
 *
 * `usageCost` is not in `ProviderCapabilities` yet (architect's §4 fold); this
 * provider reports `costUsd` when its config says the endpoint's numbers are
 * comparable, which for Claude they are and for DeepInfra the spike found they
 * are not.
 */

import { fleetError, toFleetError, type PeerState, type TurnId } from '@fleet/foundation-core'
import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderSessionRef,
  SessionHandle,
  SessionSpec,
  Turn,
  Usage,
} from '@fleet/runtime-provider-sdk'
import type { ProviderWithResume } from '@fleet/runtime-provider-sdk'

import { openingMessage } from './brief.ts'
import type { AdapterEvent } from './events.ts'
import { ClaudeSession, defaultSessionConfig, type ClaudeSessionConfig } from './session.ts'

export interface ClaudeProviderConfig extends Partial<ClaudeSessionConfig> {
  /** Defaults to `claude`. The DeepInfra provider sets `deepinfra` and passes its own limits. */
  readonly id?: string
}

export class ClaudeProvider implements ProviderWithResume {
  readonly id: string
  readonly capabilities: ProviderCapabilities & { resume: true } = {
    resume: true,
    modelSwitch: true,
    usageTokens: true,
    structuredOutput: true,
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  }

  readonly #config: ClaudeSessionConfig
  readonly #sessions = new Map<string, ClaudeSession>()

  constructor(config: ClaudeProviderConfig = {}) {
    const { id, ...sessionConfig } = config
    this.id = id ?? 'claude'
    this.#config = { ...defaultSessionConfig, ...sessionConfig, providerId: this.id }
  }

  /** Start a session from a spec. A `resumeRef` in the spec is honoured here (§7). */
  async start(spec: SessionSpec): Promise<SessionHandle> {
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

  async model(handle: SessionHandle): Promise<{ id: string; endpoint?: string }> {
    const session = this.#session(handle)
    const endpoint = session.endpoint
    return endpoint === undefined ? { id: session.model } : { id: session.model, endpoint }
  }

  events(handle: SessionHandle): AsyncIterable<ProviderEvent> {
    return this.#session(handle).events()
  }

  // ------------------------------------------------- below the interface
  //
  // These are the §4 fold's `answer()` / `respond()` and the model switch, which
  // `Provider` does not declare yet. They are real methods on the concrete
  // provider so the supervisor can call them today; when the contract lands
  // they move onto the interface and this section loses its comment.

  /** Answer the peer's question, by id or (while the id is not on the event) the oldest open one. */
  answer(handle: SessionHandle, text: string, questionId?: string): void {
    this.#session(handle).answer(text, questionId)
  }

  /** Allow or deny a tool call the permission mode blocked. */
  respond(handle: SessionHandle, decision: 'allow' | 'deny', requestId?: string): void {
    this.#session(handle).respond(decision, requestId)
  }

  /** What the peer is blocked on, with the ids `answer()` and `respond()` take. */
  pending(handle: SessionHandle): ReturnType<ClaudeSession['pending']> {
    return this.#session(handle).pending()
  }

  /** Change the model on a live session (`capabilities.modelSwitch`). */
  async setModel(handle: SessionHandle, model: string): Promise<void> {
    return this.#session(handle).setModel(model)
  }

  /** The adapter's own stream, including the events the current contract cannot carry. */
  detailEvents(handle: SessionHandle): AsyncIterable<AdapterEvent> {
    return this.#session(handle).detailEvents()
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
