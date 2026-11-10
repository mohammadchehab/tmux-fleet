/**
 * Shared fleet coordination data: pace, capacity, and heartbeat published to
 * the fleet-coord repository (§2, §9). Phase 1 publishes these; phase 2+ adds
 * masked claims and bids behind a `taskData` switch.
 */

import { array, objectAs, optional, positiveInt, string, timestamp, type Schema } from '@fleet/foundation-core'

/** Budget pace: spend to date, monthly cap, and pace ratio. */
export interface BudgetReport {
  readonly cap: number
  readonly spent: number
  /** `spent / cap` against `elapsed / month`: below 1 is under pace, above 1 is over. */
  readonly pace: number
}

export const budgetReport = (): Schema<BudgetReport> =>
  objectAs<BudgetReport>()({
    cap: positiveInt(),
    spent: positiveInt(),
    pace: positiveInt(),
  })

/** Idle peers by role, so under-pace fleets know who can take work. */
export interface CapacityByRole {
  readonly role: string
  readonly idle: number
}

export const capacityByRole = (): Schema<CapacityByRole> =>
  objectAs<CapacityByRole>()({
    role: string({ minLength: 1, maxLength: 80 }),
    idle: positiveInt(),
  })

/** What a fleet publishes on its own branch: pace, capacity, and heartbeat. */
export interface CoordinationFleetState {
  /** The owner's monthly spend cap and spend to date. */
  readonly budget: BudgetReport
  /** Idle peers by role. */
  readonly capacity: readonly CapacityByRole[]
  /** ISO8601 timestamp: when this fleet last polled the repository. */
  readonly heartbeat: string
}

export const coordinationFleetState = (): Schema<CoordinationFleetState> =>
  objectAs<CoordinationFleetState>()({
    budget: budgetReport(),
    capacity: array(capacityByRole()),
    heartbeat: timestamp(),
  })
