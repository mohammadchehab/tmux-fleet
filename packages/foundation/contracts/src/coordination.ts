/**
 * What a shared fleet publishes about itself (shared-fleet.md §3): its budget
 * pace and its idle capacity, on its own branch of the coordination repository.
 *
 * It is plaintext on purpose — nothing in it is about the customer — which is
 * also why it is so small: §9's `taskData: false` promises that the bytes a fleet
 * pushes carry nothing derived from the customer, and every field added here is
 * a field that promise has to be re-argued for.
 *
 * Another fleet's document is untrusted input: it is decoded with this schema,
 * strictly and with bounds, before anything reads a field of it.
 */

import { array, count, literal, number, objectAs, string, timestamp, type Schema, type Timestamp } from '@fleet/foundation-core'
import { MONTH_PATTERN } from './projections/ops.ts'

/** The one file a fleet branch holds in phase 1. */
export const FLEET_PACE_FILE = 'pace.json'

/** Idle peers of one role: who could take work right now. */
export interface IdleCapacity {
  readonly role: string
  readonly idle: number
}

export interface FleetPace {
  /** The document's own version, so a fleet on an older build can skip one it cannot read. */
  readonly version: 1
  /** The month `spentUsd` is for, `YYYY-MM` in UTC. */
  readonly month: string
  /** The owner's monthly cap. */
  readonly capUsd: number
  /** Priced spend so far this month; a floor when `unpricedTurns` is above 0. */
  readonly spentUsd: number
  readonly unpricedTurns: number
  /**
   * `spentUsd / capUsd` against the share of the month gone: below 1 is under
   * pace, above 1 is over. Derived, and published so every reader agrees on one
   * number rather than recomputing it against its own clock.
   */
  readonly pace: number
  readonly capacity: readonly IdleCapacity[]
  /** When this fleet last published; an old one means the fleet is offline (§2.3). */
  readonly heartbeat: Timestamp
}

export const fleetPace = (): Schema<FleetPace> =>
  objectAs<FleetPace>()({
    version: literal(1),
    month: string({ pattern: MONTH_PATTERN }),
    capUsd: number({ min: 0, max: 1_000_000 }),
    spentUsd: number({ min: 0, max: 1_000_000 }),
    unpricedTurns: count(),
    pace: number({ min: 0, max: 1_000_000 }),
    capacity: array(
      objectAs<IdleCapacity>()({ role: string({ minLength: 1, maxLength: 80 }), idle: count() }),
      { maxItems: 50 },
    ),
    heartbeat: timestamp(),
  })
