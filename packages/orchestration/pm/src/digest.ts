/**
 * Hashing and id derivation for the PM (architecture §5.4), re-exported from
 * `@fleet/foundation-core` so the PM's import sites do not change.
 *
 * The helpers moved to foundation because `security/findings` needs the same
 * structural hash for a finding's fingerprint (§6.2), and `tests/architecture`
 * forbids one group importing another's file. The reasoning lives with the
 * code, in `packages/foundation/core/src/digest.ts`.
 */

export { deriveId, digestOf, shortHash } from '@fleet/foundation-core'
