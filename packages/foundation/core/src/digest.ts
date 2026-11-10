/**
 * Hashing and id derivation (§5.4, §6.2).
 *
 * Two things here exist because a decision must be a pure, replayable function:
 *
 * - `digestOf`/`shortHash` hash a value structurally, so an `inputsHash`
 *   answers "did the inputs change?" rather than "did the store hand them over
 *   in the same order?". Object keys are sorted and `undefined` is dropped
 *   before hashing, so two equal values always hash alike.
 * - `deriveId` mints an opaque id in core's `<prefix>_<16 hex>` shape from the
 *   inputs instead of from a random uuid. Ids that name something with no
 *   inputs (`newBriefId()` and friends) are random by design, but an id derived
 *   from its inputs makes a replay produce the same id: a second run sees the
 *   same question, or the same finding, rather than a new one (§5.4).
 *
 * They live in `foundation` rather than in one group because two groups need
 * the same rule — the PM's derived decision ids (§5.2) and a finding's
 * fingerprint (§6.2) — and `tests/architecture` forbids one group importing
 * another's helper.
 */

import { createHash } from 'node:crypto'

/**
 * JSON with object keys sorted and `undefined` fields dropped: a stable string
 * for an equal-shaped value.
 */
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

/** The first 16 hex of a digest: an `inputsHash`, a fingerprint, the tail of a derived id. */
export const shortHash = (value: unknown): string => digestOf(value).slice(0, 16)

/**
 * `<prefix>_<16 hex>` derived from `value`: core's opaque-id shape, minus the
 * randomness, so the same inputs always name the same thing (§5.4).
 */
export const deriveId = (prefix: string, value: unknown): string => `${prefix}_${shortHash(value)}`
