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

import { array, count, literal, number, objectAs, optional, record, string, timestamp, type Schema, type Timestamp } from '@fleet/foundation-core'
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

/**
 * The record a key rotation carries beside the copies (shared-fleet.md §5): who
 * the key was sealed for, who of them had no key it could be sealed to, and who
 * made it. A rotation is `<ns>/rotate/<n>`, created once; its files are this
 * document and one `<login>.age` per member who could receive a copy. The
 * highest `n` is the current key.
 */
export const ROTATION_FILE = 'rotation.json'

export interface KeyRotation {
  readonly version: 1
  readonly rotation: number
  /** The team as it was read when the key was made, sorted. */
  readonly members: readonly string[]
  /** Members with no `ssh-ed25519` or `ssh-rsa` key on GitHub, so no copy. */
  readonly missing: readonly string[]
  /**
   * For each member who got a copy: the sha256 (hex) of each recipient it was
   * sealed to, sorted. Per key and not one hash of the set, so a look can tell a
   * key that was added (the copy is still sealed to every key it was) from one
   * that was replaced or removed (it is sealed to a key the member no longer has).
   * Absent on a record made before it was written; that record is rotated over
   * once, because nothing in it says which keys its copies were sealed to.
   */
  readonly recipients?: Readonly<Record<string, readonly string[]>>
  /** The login of the fleet that made this rotation. */
  readonly by: string
  readonly at: Timestamp
}

const login = (): Schema<string> => string({ pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/ })

export const keyRotation = (): Schema<KeyRotation> =>
  objectAs<KeyRotation>()({
    version: literal(1),
    rotation: number({ int: true, min: 1, max: 999_999_999 }),
    members: array(login(), { maxItems: 500 }),
    missing: array(login(), { maxItems: 500 }),
    recipients: optional(record(array(string({ pattern: /^[0-9a-f]{64}$/ }), { maxItems: 100 }))),
    by: login(),
    at: timestamp(),
  })
