/**
 * Conformance helpers (architecture §4, §1.1 `tests/conformance/providers`).
 * One suite every provider package must pass, so "a provider that cannot do
 * something says so in `capabilities`" is a test, not a convention.
 *
 * Phase 0 defines the shape of the suite; phase 1 supplies the fixtures
 * (`tests/fixtures/provider-streams`) and the first providers.
 */

import { toFleetError } from '@fleet/foundation-core'
import type { ProviderCapabilities } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle, SessionSpec } from './provider.ts'

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
      const flags: readonly (keyof ProviderCapabilities)[] = [
        'resume',
        'modelSwitch',
        'usageTokens',
        'usageCost',
        'structuredOutput',
      ]
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
]

/**
 * A check that needs a session actually running: it is handed a provider and a
 * handle it started, and may drive that session (resume it, then stop it).
 * `capabilityChecks` cannot observe this — a capability is a promise until the
 * method behind it is called.
 */
export interface SessionCheck {
  readonly name: string
  readonly because: string
  readonly run: (subject: SessionSubject) => Promise<string | null>
}

export interface SessionSubject {
  readonly provider: Provider
  readonly handle: SessionHandle
  /** The spec `handle` was started from. */
  readonly spec: SessionSpec
}

/**
 * The checks that need a live session. Phase 1 providers run these in their own
 * package (`tests/conformance/providers`); phase 0 defines the rule.
 */
export const resumeChecks = (): readonly SessionCheck[] => [
  {
    name: 'the handle names the turn the session was started with',
    because:
      'a provider that emits nothing until something is pushed at it has a turn running before any observer attaches; briefTurnId is how the supervisor accounts for it, so it must be a real TurnId the first turn.started can refer to (§4)',
    run: async ({ handle }) => {
      const id = handle.briefTurnId
      if (typeof id !== 'string' || !/^trn_[0-9a-f]{16}$/.test(id)) {
        return `SessionHandle.briefTurnId "${String(id)}" is not a TurnId`
      }
      return null
    },
  },
  {
    name: 'usage() reports cost only when capabilities.usageCost says so',
    because:
      'a vendor priced at another vendor’s rates produces a number that looks real; the spend ledger records null instead (§4, §11)',
    run: async ({ provider, handle }) => {
      let usage
      try {
        usage = await provider.usage(handle)
      } catch (thrown) {
        return `usage() threw: ${toFleetError(thrown, 'provider_failed').message}`
      }
      if (provider.capabilities.usageCost) {
        return typeof usage.costUsd === 'number' ? null : 'usage() omitted costUsd although capabilities.usageCost is true'
      }
      return usage.costUsd === undefined ? null : 'usage() reported costUsd although capabilities.usageCost is false'
    },
  },
  {
    name: 'resume() does what capabilities.resume says',
    because:
      'the interface is uniform — resume() is always callable — so the capability must not lie: false rejects unsupported, true returns a usable session (§4, §13, §16)',
    run: async ({ provider, handle, spec }) => {
      const resumeSpec: SessionSpec = { ...spec, resumeRef: handle.sessionRef }
      let resumed: SessionHandle
      try {
        resumed = await provider.resume(handle.sessionRef, resumeSpec)
      } catch (thrown) {
        const error = toFleetError(thrown, 'provider_failed')
        if (provider.capabilities.resume) {
          return `resume() rejected with ${error.code} although capabilities.resume is true: ${error.message}`
        }
        return error.code === 'unsupported'
          ? null
          : `resume() must reject FleetError('unsupported') when capabilities.resume is false, got ${error.code}: ${error.message}`
      }

      // It returned, so the session is real: stop it before reporting.
      try {
        await provider.stop(resumed)
      } catch (thrown) {
        const error = toFleetError(thrown, 'provider_failed')
        return `resume() returned a session that stop() could not close: ${error.message}`
      }

      if (!provider.capabilities.resume) {
        return 'resume() returned a session although capabilities.resume is false'
      }
      if (typeof resumed.sessionId !== 'string' || resumed.sessionId === '') {
        return 'resume() returned a session with no sessionId'
      }
      if (resumed.peerId !== handle.peerId || resumed.providerId !== handle.providerId) {
        return `resume() returned a foreign session (${resumed.providerId}/${resumed.peerId}, expected ${handle.providerId}/${handle.peerId})`
      }
      return null
    },
  },
  {
    name: 'setModel() does what capabilities.modelSwitch says',
    because:
      'the interface is uniform — setModel() is always callable — so the capability must not lie: false rejects unsupported, true accepts the switch and model() then reports the requested model (§4)',
    run: async ({ provider, handle }) => {
      const requested = `${handle.model}-switched`
      try {
        await provider.setModel(handle, requested)
      } catch (thrown) {
        const error = toFleetError(thrown, 'provider_failed')
        if (provider.capabilities.modelSwitch) {
          return `setModel() rejected with ${error.code} although capabilities.modelSwitch is true: ${error.message}`
        }
        return error.code === 'unsupported'
          ? null
          : `setModel() must reject FleetError('unsupported') when capabilities.modelSwitch is false, got ${error.code}: ${error.message}`
      }
      if (!provider.capabilities.modelSwitch) {
        return 'setModel() succeeded although capabilities.modelSwitch is false'
      }
      const reported = await provider.model(handle)
      return reported.id === requested
        ? null
        : `model() reports ${reported.id} after setModel(${requested}); it must report the requested model`
    },
  },
]
