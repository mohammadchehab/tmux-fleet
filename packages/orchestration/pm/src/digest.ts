/**
 * Hashing and id derivation for the PM (architecture §5.4).
 *
 * Two things here exist because `decide` must be a pure, replayable function:
 *
 * - `shortHash` hashes a value structurally, so `inputsHash` answers "did the
 *   inputs change?" rather than "did the store hand them over in the same
 *   order?". Object keys are sorted and `undefined` is dropped before hashing,
 *   so two equal snapshots always hash alike.
 * - `deriveId` mints an opaque id in core's `<prefix>_<16 hex>` shape from the
 *   inputs instead of from a random uuid. `newBriefId()` and friends are random
 *   by design (they mint identities for things that have no inputs), but a
 *   `decide` that minted a random brief id could not be replayed: the second
 *   run would produce a different action for the same state, which is exactly
 *   the diff §5.4 is meant to mean something.
 */

import { createHash } from 'node:crypto'

/** JSON with object keys sorted and `undefined` fields dropped: a stable string for an equal-shaped value. */
const canonical = (value: unknown): string => {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The sha-256 of a value's canonical form, hex. Never parsed; compared for equality (§5.4). */
export const digestOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')

/** The first 16 hex of a digest: an `inputsHash`, and the tail of a derived id. */
export const shortHash = (value: unknown): string => digestOf(value).slice(0, 16)

/**
 * `<prefix>_<16 hex>` derived from `value`: core's opaque-id shape, minus the randomness, so the same inputs
 * always name the same thing (§5.4). A repeat is then the same question, not a second one.
 */
export const deriveId = (prefix: string, value: unknown): string => `${prefix}_${shortHash(value)}`
