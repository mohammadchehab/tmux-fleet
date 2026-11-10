/**
 * Conformance helpers (architecture §4, §1.1 `tests/conformance/providers`).
 * One suite every provider package must pass, so "a provider that cannot do
 * something says so in `capabilities`" is a test, not a convention.
 *
 * Phase 0 defines the shape of the suite; phase 1 supplies the fixtures
 * (`tests/fixtures/provider-streams`) and the first providers.
 */

import type { ProviderCapabilities } from '@fleet/foundation-contracts'
import type { Provider } from './provider.ts'

/** A recorded provider event stream, replayed against `events()` in a test. */
export interface ProviderStreamFixture {
  readonly providerId: string
  readonly label: string
  /** The events as the provider emitted them, plus the usage a session reported. */
  readonly events: readonly unknown[]
}

export interface ConformanceCheck {
  readonly name: string
  /** Why the check exists, citing the section it enforces. */
  readonly because: string
  /** A check returns a failure message, or `null` when it passes. */
  readonly run: (provider: Provider) => Promise<string | null>
}

/**
 * The checks that need no session: they hold as soon as a provider is
 * constructed, so `apps/daemon` can refuse to register a provider that would
 * mislead the supervisor.
 */
export const capabilityChecks = (): readonly ConformanceCheck[] => [
  {
    name: 'declares a stable id',
    because: 'a provider is looked up by id in ProviderRegistry (§1.1, §4)',
    run: async (provider) =>
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(provider.id) && provider.id.length <= 40
        ? null
        : `id "${provider.id}" is not provider-shaped`,
  },
  {
    name: 'declares every capability explicitly',
    because: 'a provider that cannot do something says so; the supervisor adapts, it does not guess (§4)',
    run: async (provider) => {
      const flags: readonly (keyof ProviderCapabilities)[] = ['resume', 'modelSwitch', 'usageTokens', 'structuredOutput']
      const missing = flags.filter((key) => typeof provider.capabilities[key] !== 'boolean')
      return missing.length === 0 ? null : `capabilities must state ${missing.join(', ')} as a boolean`
    },
  },
  {
    name: 'declares a non-empty, duplicate-free set of permission modes',
    because: 'SessionSpec.permissionMode must be one the provider honours (§4)',
    run: async (provider) => {
      const modes = provider.capabilities.permissionModes
      if (modes.length === 0) return 'capabilities.permissionModes is empty'
      if (new Set(modes).size !== modes.length) return 'capabilities.permissionModes repeats a mode'
      return null
    },
  },
  {
    name: 'predicts whether it can resume',
    because: 'resume: false is a promise the supervisor plans around, not a hint (§4, §16)',
    run: async (provider) =>
      provider.capabilities.resume === true || provider.capabilities.resume === false
        ? null
        : 'capabilities.resume must be a boolean',
  },
  {
    name: 'reports usage or says it cannot',
    because: 'the self-purge trigger falls back to turn count when usageTokens is false (§8)',
    run: async (provider) =>
      provider.capabilities.usageTokens === true || provider.capabilities.usageTokens === false
        ? null
        : 'capabilities.usageTokens must be a boolean',
  },
]
