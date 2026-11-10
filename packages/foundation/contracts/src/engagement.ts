/**
 * Shared fleet engagement and key management (§5, §9). An engagement is a
 * team of developers on a customer epic, pooling their budgets via shared fleet
 * coordination. The engagement key is rotated on every departure and encrypted
 * to each member's GitHub SSH key.
 */

import { objectAs, positiveInt, string, timestamp, type Schema } from '@fleet/foundation-core'

/** An engagement: a customer epic and the team working on it. */
export interface Engagement {
  /** Engagement code name, e.g. `eng-07`. Mapped to the customer only in the local profile. */
  readonly code: string
  /** GitHub team: `org/team-name`. Only members can read and write the coordination repository. */
  readonly team: string
  /** The GitHub organization that owns the fleet-coord repository. */
  readonly org: string
  /** Repository name, usually `fleet-coord`. */
  readonly repo: string
}

export const engagement = (): Schema<Engagement> =>
  objectAs<Engagement>()({
    code: string({ minLength: 5, maxLength: 20 }),
    team: string({ minLength: 3, maxLength: 200 }),
    org: string({ minLength: 1, maxLength: 100 }),
    repo: string({ minLength: 1, maxLength: 100 }),
  })

/** The engagement key metadata stored in the repository. */
export interface EngagementKey {
  /** Current rotation number. Incremented on every key rotation. */
  readonly rotation: number
  /** ISO8601 timestamp: when the current key was created. */
  readonly createdAt: string
}

export const engagementKey = (): Schema<EngagementKey> =>
  objectAs<EngagementKey>()({
    rotation: positiveInt(),
    createdAt: timestamp(),
  })
