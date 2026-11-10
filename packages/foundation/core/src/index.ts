/**
 * `@fleet/foundation-core`: ids, the event envelope, `PeerState`, Result/Error,
 * the structural digest, the schema combinators, the profile path layout and the
 * secret redaction text passes through before it leaves the process.
 * Pure helpers only — no domain logic that another group owns, and no I/O:
 * `node:crypto` mints ids and hashes, `node:os`/`node:path` derive where a
 * profile's files live, and nothing here opens, reads or writes one
 * (architecture §1.1).
 */

export * from './schema.ts'
export * from './result.ts'
export * from './errors.ts'
export * from './ids.ts'
export * from './digest.ts'
export * from './event.ts'
export * from './peer-state.ts'
export * from './clock.ts'
export * from './paths.ts'
export * from './redact.ts'
