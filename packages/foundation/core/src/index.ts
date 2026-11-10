/**
 * `@fleet/foundation-core`: ids, the event envelope, `PeerState`, Result/Error,
 * the structural digest and the schema combinators. Pure helpers only — no
 * domain logic that another group owns, no I/O beyond `node:crypto` for minting
 * ids and hashing (architecture §1.1).
 */

export * from './schema.ts'
export * from './result.ts'
export * from './errors.ts'
export * from './ids.ts'
export * from './digest.ts'
export * from './event.ts'
export * from './peer-state.ts'
export * from './clock.ts'
