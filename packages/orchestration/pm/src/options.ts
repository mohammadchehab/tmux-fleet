/**
 * The knobs a rule may read (architecture §5.2, §10). Everything a rule needs to know that is not in the
 * `FleetState` — the PR cap, how long idle is idle, which role's review satisfies the gate — arrives here, so a
 * test states a policy instead of arranging a fleet around one.
 *
 * None of these are read from the clock or from config: `decide` is handed its options by the caller that owns
 * them, which is what keeps it pure and a replay identical (§5.4).
 */

import { fleetError } from '@fleet/foundation-core'
import type { MergeMethod } from '@fleet/foundation-contracts'

export interface PmOptions {
  /** §5.2 `assign`: how many open PRs a peer may have before the PM stops handing it Work. */
  readonly prCap?: number
  /** §5.2 `idle`: how long a peer must sit idle before the PM calls it spare capacity. */
  readonly idleMinutes?: number
  /** §10: how the gate merges. `squash` unless the profile says otherwise. */
  readonly mergeMethod?: MergeMethod
  /** §10: the role whose approval satisfies the gate. Without one running, the gate asks the user. */
  readonly reviewerRole?: string
  /** §5.2 `dedupe`: how alike two cards must be (Jaccard over their words, 0–1) before the Judge is asked. */
  readonly duplicateThreshold?: number
  /** §5.3 `thin_card`: a description shorter than this many characters is a card with no goal. */
  readonly thinCardChars?: number
  /**
   * §6.1: the fleet's soft cap, in USD. Once the ledger's bill for the fleet reaches it, the tick asks the user
   * whether to continue or raise it. No cap means no question — a default would make every fleet ask one.
   */
  readonly budgetUsd?: number
}

export interface ResolvedPmOptions {
  readonly prCap: number
  readonly idleMinutes: number
  readonly mergeMethod: MergeMethod
  readonly reviewerRole: string
  readonly duplicateThreshold: number
  readonly thinCardChars: number
  /** Absent when the profile sets no cap, which is the only value that means "never ask". */
  readonly budgetUsd?: number
}

export const defaultPmOptions: ResolvedPmOptions = {
  prCap: 2,
  idleMinutes: 10,
  mergeMethod: 'squash',
  reviewerRole: 'pr-architect',
  duplicateThreshold: 0.6,
  thinCardChars: 120,
}

const given = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value)

/** Fill the defaults; an explicit `undefined` is "not set", never "set to nothing". */
export const resolveOptions = (options: PmOptions = {}): ResolvedPmOptions => {
  // The profile schema refuses these already; this is the one place a budget reaches the rule, so it refuses them too.
  if (options.budgetUsd !== undefined && !(Number.isFinite(options.budgetUsd) && options.budgetUsd > 0)) {
    throw fleetError('invalid_input', `a budget is a finite number of USD above zero, got ${String(options.budgetUsd)}`)
  }
  return resolveDefaults(options)
}

const resolveDefaults = (options: PmOptions): ResolvedPmOptions => ({
  prCap: given(options.prCap, defaultPmOptions.prCap),
  idleMinutes: given(options.idleMinutes, defaultPmOptions.idleMinutes),
  mergeMethod: given(options.mergeMethod, defaultPmOptions.mergeMethod),
  reviewerRole: given(options.reviewerRole, defaultPmOptions.reviewerRole),
  duplicateThreshold: given(options.duplicateThreshold, defaultPmOptions.duplicateThreshold),
  thinCardChars: given(options.thinCardChars, defaultPmOptions.thinCardChars),
  // Not defaulted: an undefined cap means the profile never set one, and `given` would need a sentinel number.
  ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }),
})
