/**
 * DeepInfra as a `Provider` (§4).
 *
 * It is the Claude implementation — the Agent SDK pointed at DeepInfra's
 * Anthropic-compatible endpoint (`docs/design/spikes/agent-sdk.md`) — plus the
 * three things the spike found the SDK gets wrong when the endpoint is not
 * Anthropic's:
 *
 * 1. **The context window.** The CLI reports `rawMaxTokens: 200 000` for
 *    `deepseek-ai/DeepSeek-V4.1-Flash-1017`, whose real window is 1 048 576. It
 *    is guessing the window of a model it does not know, and trusting it would
 *    self-purge at 20 % of the context the session actually has (§8). So the
 *    limit comes from config, and a model with no configured window is refused
 *    at `start` rather than given a default nobody measured.
 * 2. **The cost.** `total_cost_usd` is priced at Claude list rates with
 *    `costBasis: 'unknown'` — wrong by an order of magnitude. `usageCost` is
 *    therefore false and `usage()` reports no `costUsd`, so the §11 ledger
 *    records null instead of a number that looks like money.
 * 3. **The endpoint.** The SDK cannot report it (`provider: 'firstParty'` even
 *    here), so the spec must say it and `model()` reports what the spec said.
 *
 * The env is part of `SessionSpec` and belongs to that one process, which is
 * what removes v1's shared-tmux env drift (§4, §13, §14.1). `deepInfraEnv()`
 * builds the fragment; the key is passed in, never read from disk here and
 * never put in an error, a log line or an event.
 */

import {
  claudeCapabilities,
  ClaudeProvider,
  type ClaudeProviderConfig,
} from '@fleet/runtime-provider-claude'
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

/** DeepInfra's Anthropic-compatible endpoint (spike §1). */
export const DEEP_INFRA_BASE_URL = 'https://api.deepinfra.com/anthropic'

/**
 * The context windows DeepInfra reports in its own model metadata, not the
 * window the SDK guesses. Adding a model here is how a new one becomes usable;
 * the value is the vendor's `context_length`, and it is the only source §8's
 * purge trigger trusts.
 */
export const DEEP_INFRA_CONTEXT_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  'deepseek-ai/DeepSeek-V4.1-Flash-1017': 1_048_576,
})

/** The model the fleet uses unless a spec says otherwise. */
export const DEEP_INFRA_DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

/**
 * What this endpoint can do: everything the Agent SDK can, except cost. See the
 * file header for the evidence behind `usageCost: false`.
 */
export const deepInfraCapabilities: ProviderCapabilities = Object.freeze({
  ...claudeCapabilities,
  usageCost: false,
})

export interface DeepInfraProviderConfig extends Omit<ClaudeProviderConfig, 'id' | 'capabilities' | 'limits'> {
  /** The endpoint, when the fleet runs a proxy or a staging host rather than the public one. */
  readonly baseUrl?: string
  /** Extra models and their real windows; merged over `DEEP_INFRA_CONTEXT_LIMITS`. */
  readonly contextLimits?: Readonly<Record<string, number>>
  /**
   * Overrides for `deepInfraCapabilities`, narrowing only. A narrowed capability
   * makes the matching method reject `unsupported` (see `ClaudeProvider`); a
   * widening one is refused at construction (see `narrowCapabilities`).
   */
  readonly capabilities?: Partial<ProviderCapabilities>
}

/**
 * The env fragment a DeepInfra session needs, and the only sanctioned way to
 * build one: the endpoint, the token, and nothing else.
 *
 * @throws FleetError('invalid_input') on an empty token — a missing key must
 * fail before a process spawns, not as an authentication error mid-turn.
 */
export const deepInfraEnv = (
  authToken: string,
  config: Pick<DeepInfraProviderConfig, 'baseUrl'> = {},
): Readonly<Record<string, string>> => {
  if (typeof authToken !== 'string' || authToken.trim().length === 0) {
    throw fleetError('invalid_input', 'a DeepInfra session needs a non-empty ANTHROPIC_AUTH_TOKEN')
  }
  return Object.freeze({
    ANTHROPIC_BASE_URL: config.baseUrl ?? DEEP_INFRA_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: authToken,
  })
}

/**
 * The capabilities a config may ask for: the base set, narrowed.
 *
 * A capability is a promise the supervisor plans around (§4) — whether it may
 * resume, whether `usage()` is measured enough to purge on (§8), whether the
 * spend ledger gets a number or null (§11) — so widening one makes this adapter
 * promise what it was measured not to do. `usageCost: true` is the sharpest
 * case: it would put SDK-priced dollars into the ledger as if the vendor had
 * priced them, which is the number this provider exists to refuse. A widening is
 * therefore refused at construction rather than honoured, and so is a permission
 * mode the endpoint does not honour.
 */
export const narrowCapabilities = (
  base: ProviderCapabilities,
  overrides: Partial<ProviderCapabilities> | undefined,
): ProviderCapabilities => {
  if (overrides === undefined) return base
  const widened = capabilityFlags.filter((flag) => overrides[flag] === true && !base[flag])
  if (widened.length > 0) {
    throw fleetError('invalid_input', `capabilities cannot be widened: ${widened.join(', ')}`, {
      details: { providerId: 'deepinfra', widened },
    })
  }
  const added = (overrides.permissionModes ?? []).filter((mode) => !base.permissionModes.includes(mode))
  if (added.length > 0) {
    throw fleetError('invalid_input', `permission modes cannot be added: ${added.join(', ')}`, {
      details: { providerId: 'deepinfra', permissionModes: added },
    })
  }
  return Object.freeze({
    ...base,
    ...overrides,
    permissionModes: Object.freeze(overrides.permissionModes ?? base.permissionModes),
  })
}

/** The capabilities that are a yes/no, so "narrowing" means one direction only. */
const capabilityFlags = ['resume', 'modelSwitch', 'usageTokens', 'usageCost', 'structuredOutput'] as const

export class DeepInfraProvider implements Provider {
  readonly id = 'deepinfra'
  readonly capabilities: ProviderCapabilities

  readonly #inner: ClaudeProvider
  readonly #limits: Readonly<Record<string, number>>
  readonly #baseUrl: string

  constructor(config: DeepInfraProviderConfig = {}) {
    const { baseUrl, contextLimits, capabilities, ...sessionConfig } = config
    this.capabilities = narrowCapabilities(deepInfraCapabilities, capabilities)
    this.#baseUrl = baseUrl ?? DEEP_INFRA_BASE_URL
    this.#limits = Object.freeze({ ...DEEP_INFRA_CONTEXT_LIMITS, ...contextLimits })
    // No `fallback`: an unlisted model has no measured window, so it is refused
    // below instead of being handed one. Passing 1 makes `contextLimitFor` throw
    // rather than invent a number — the provider never reaches that, but the
    // config should not pretend to know either.
    this.#inner = new ClaudeProvider({
      ...sessionConfig,
      id: this.id,
      limits: { byModel: this.#limits, fallback: 1 },
      capabilities: this.capabilities,
    })
  }

  /**
   * Validate what the spec claims about DeepInfra, then start the session.
   *
   * A spec that would run somewhere else, or as a model whose window is unknown,
   * is a caller bug and fails here with a typed code — before a process spawns,
   * because a session that starts on the wrong endpoint looks healthy until it
   * answers with the wrong model's words, and a session given a guessed window
   * self-purges early (§8, §13).
   */
  async start(spec: SessionSpec): Promise<SessionHandle> {
    this.#check(spec)
    try {
      return await this.#inner.start(spec)
    } catch (thrown) {
      throw toFleetError(thrown, 'provider_failed')
    }
  }

  async resume(ref: ProviderSessionRef, spec: SessionSpec): Promise<SessionHandle> {
    this.#check(spec)
    try {
      return await this.#inner.resume(ref, spec)
    } catch (thrown) {
      throw toFleetError(thrown, 'provider_failed')
    }
  }

  async send(handle: SessionHandle, turn: Turn): Promise<TurnId> {
    return this.#inner.send(handle, turn)
  }

  async interrupt(handle: SessionHandle, turn?: TurnId): Promise<void> {
    return this.#inner.interrupt(handle, turn)
  }

  async stop(handle: SessionHandle): Promise<void> {
    return this.#inner.stop(handle)
  }

  async status(handle: SessionHandle): Promise<PeerState> {
    return this.#inner.status(handle)
  }

  async usage(handle: SessionHandle): Promise<Usage> {
    return this.#inner.usage(handle)
  }

  async model(handle: SessionHandle): Promise<{ id: string; endpoint?: string }> {
    return this.#inner.model(handle)
  }

  events(handle: SessionHandle): AsyncIterable<ProviderEvent> {
    return this.#inner.events(handle)
  }

  async answer(handle: SessionHandle, questionId: QuestionId, answer: QuestionAnswer): Promise<void> {
    return this.#inner.answer(handle, questionId, answer)
  }

  async respond(handle: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.#inner.respond(handle, requestId, decision)
  }

  /** Not on `Provider` yet, as on the Claude provider: the decision inbox reads it. */
  pending(handle: SessionHandle): ReturnType<ClaudeProvider['pending']> {
    return this.#inner.pending(handle)
  }

  async setModel(handle: SessionHandle, model: string): Promise<void> {
    // A switch to a model with no configured window would leave `usage()`
    // unable to report a limit, which is the one number §8 acts on.
    if (this.#limits[model] === undefined) {
      throw fleetError('invalid_input', `no context limit configured for DeepInfra model ${model}`, {
        details: { model, known: Object.keys(this.#limits) },
      })
    }
    return this.#inner.setModel(handle, model)
  }

  /** Refuse a spec before anything spawns; the first thing wrong is the one reported. */
  #check(spec: SessionSpec): void {
    if (this.#limits[spec.model] === undefined) {
      throw fleetError('invalid_input', `no context limit configured for DeepInfra model ${spec.model}`, {
        details: { model: spec.model, known: Object.keys(this.#limits) },
      })
    }
    const endpoint = spec.env.ANTHROPIC_BASE_URL
    if (endpoint === undefined) {
      throw fleetError('invalid_input', `peer ${spec.peerId}: a DeepInfra session must set ANTHROPIC_BASE_URL`, {
        // Names only: the env carries a credential and none of it belongs in an error.
        details: { peerId: spec.peerId, expected: 'ANTHROPIC_BASE_URL', got: Object.keys(spec.env).sort() },
      })
    }
    if (endpoint !== this.#baseUrl) {
      throw fleetError(
        'config_mismatch',
        `peer ${spec.peerId}: the spec points a DeepInfra session at ${endpoint}, not ${this.#baseUrl}`,
        { details: { peerId: spec.peerId, expected: this.#baseUrl, observed: endpoint, key: 'ANTHROPIC_BASE_URL' } },
      )
    }
    const token = spec.env.ANTHROPIC_AUTH_TOKEN
    if (token === undefined || token.trim() === '') {
      throw fleetError('invalid_input', `peer ${spec.peerId}: a DeepInfra session must set ANTHROPIC_AUTH_TOKEN`, {
        details: { peerId: spec.peerId, expected: 'ANTHROPIC_AUTH_TOKEN' },
      })
    }
    // A Claude credential sent to DeepInfra is the drift the allowlist exists to
    // stop, and the SDK would prefer it over the token without saying so.
    if (spec.env.ANTHROPIC_API_KEY !== undefined) {
      throw fleetError('invalid_input', `peer ${spec.peerId}: a DeepInfra session must not set ANTHROPIC_API_KEY`, {
        details: { peerId: spec.peerId, unexpected: 'ANTHROPIC_API_KEY', use: 'ANTHROPIC_AUTH_TOKEN' },
      })
    }
  }
}

/** The package's one export a registry needs: a provider, built from config. */
export const createDeepInfraProvider = (config: DeepInfraProviderConfig = {}): Provider =>
  new DeepInfraProvider(config)
