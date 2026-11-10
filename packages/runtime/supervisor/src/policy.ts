/**
 * When a peer should purge its own context (§8), as a pure function of what the
 * provider measures and what the profile allows.
 *
 * The trigger is evaluated **at a turn boundary** — never mid-turn, never from
 * a transcript hook — so the peer is never interrupted while it is writing
 * something it believes is finished.
 *
 * Two things are deliberately not decided here:
 *
 * - **The limit is not the provider's number.** `Usage.contextLimit` already
 *   comes from config (§4); this module only compares against it.
 * - **What "too full" means is a ratio, not equality.** The purge itself costs
 *   context: after the trigger fires the peer still has to be asked, and to
 *   answer, with a full state file. A peer that waits for `contextTokens ===
 *   contextLimit` cannot afford the handoff that saves it.
 *
 * Providers that report no tokens (`capabilities.usageTokens === false`, §4 — a
 * Cursor-style agent that exposes no usage) fall back to turn count and wall
 * clock, which are measured locally and are the same on every provider.
 */

import { fleetError } from '@fleet/foundation-core'
import type { Usage } from '@fleet/foundation-contracts'

/** The `config/policies/limits` entry for one provider and model (§8). */
export interface PurgeLimits {
  /**
   * Purge when `contextTokens / contextLimit` reaches this. Below 1 because the
   * state-file turn runs *after* the trigger; how far below is the headroom the
   * role's largest handoff needs.
   */
  readonly contextRatio: number
  /**
   * Purge when the context reaches this fraction of the count at which the
   * provider would compact on its own — the point the peer must be handed off
   * *before*, because a compaction is money spent and context lost (§8).
   *
   * Below 1 for the same reason `contextRatio` is: the handoff turn needs room
   * to run, and the trigger is evaluated at a turn boundary, so the turn that
   * takes the ratio from 0.89 to 1.0 has to be one the peer can still finish.
   */
  readonly autoCompactRatio: number
  /** For a provider with no token usage: purge after this many turns in one session. */
  readonly maxTurns: number
  /** …or after this long, even if it has been idle. */
  readonly maxSessionMillis: number
}

/**
 * The defaults a profile that says nothing gets. Generous enough not to purge a
 * healthy session, tight enough that a long-running one hands off well before
 * the model's window is the reason it fails.
 */
export const defaultPurgeLimits: PurgeLimits = Object.freeze({
  contextRatio: 0.8,
  autoCompactRatio: 0.9,
  maxTurns: 40,
  maxSessionMillis: 3 * 60 * 60 * 1000,
})

/** Why a purge fired, in the order they are checked. */
export const purgeTriggers = ['auto_compact', 'context', 'turns', 'wall_clock'] as const
export type PurgeTrigger = (typeof purgeTriggers)[number]

/** Everything the decision reads, and nothing it has to fetch. */
export interface PurgeObservation {
  /** What `Provider.usage` reported at the turn boundary (§4). */
  readonly usage: Usage
  /** `Provider.capabilities.usageTokens`: whether `usage.contextTokens` means anything (§4). */
  readonly usageTokens: boolean
  /** Turns completed in this session. */
  readonly turns: number
  /** Milliseconds since this session started. */
  readonly sessionMillis: number
  readonly limits: PurgeLimits
}

/**
 * Validate a profile's limits at load time, so a mistyped policy is a startup
 * error rather than a fleet that never purges (or purges every turn).
 *
 * @throws FleetError('invalid_input')
 */
export const checkPurgeLimits = (limits: PurgeLimits): PurgeLimits => {
  const ratio = limits.contextRatio
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw fleetError('invalid_input', 'purge limits: contextRatio must be in (0, 1]', {
      details: { contextRatio: ratio },
    })
  }
  const autoCompact = limits.autoCompactRatio
  if (!Number.isFinite(autoCompact) || autoCompact <= 0 || autoCompact > 1) {
    throw fleetError('invalid_input', 'purge limits: autoCompactRatio must be in (0, 1]', {
      details: { autoCompactRatio: autoCompact },
    })
  }
  if (!Number.isInteger(limits.maxTurns) || limits.maxTurns < 1) {
    throw fleetError('invalid_input', 'purge limits: maxTurns must be a positive integer', {
      details: { maxTurns: limits.maxTurns },
    })
  }
  if (!Number.isFinite(limits.maxSessionMillis) || limits.maxSessionMillis <= 0) {
    throw fleetError('invalid_input', 'purge limits: maxSessionMillis must be positive', {
      details: { maxSessionMillis: limits.maxSessionMillis },
    })
  }
  return Object.freeze({ ...limits })
}

/**
 * The trigger, or `undefined` to keep working.
 *
 * The provider's own compaction point is checked first, because it is the one
 * signal that says what will happen to this session if nothing happens now: past
 * it the provider summarizes the context away, spending the money and losing
 * what the peer knew, and no other trigger in this list can pre-empt that. It is
 * also the only check whose threshold is read from the session rather than from
 * config, because it can sit far below the configured window (a 1M model under a
 * 200K compaction policy), and a ratio against the window would never fire.
 *
 * Context is checked next because it measures what the purge is for; turn count
 * and wall clock are fallbacks for a provider that cannot report it, and for a
 * session that somehow stays small while running for hours (a loop, not
 * progress).
 */
export const purgeTrigger = (observation: PurgeObservation): PurgeTrigger | undefined => {
  const { usage, limits } = observation
  if (observation.usageTokens) {
    const compactAt = usage.autoCompactAt
    if (compactAt !== undefined && compactAt > 0 && usage.contextTokens >= compactAt * limits.autoCompactRatio) {
      return 'auto_compact'
    }
    if (usage.contextLimit > 0 && usage.contextTokens / usage.contextLimit >= limits.contextRatio) return 'context'
  }
  if (observation.turns >= limits.maxTurns) return 'turns'
  if (observation.sessionMillis >= limits.maxSessionMillis) return 'wall_clock'
  return undefined
}
