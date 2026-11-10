/**
 * `@fleet/runtime-supervisor` — session lifecycle and the self-purge wrapper
 * (architecture §2, §4, §8).
 *
 * - `peer-state.ts` — provider events → the peer state the fleet shows.
 * - `policy.ts` — when a turn boundary means "purge" (context, turns, clock).
 * - `state.ts` — the typed state file: the ask, its validation, the human copy.
 * - `records.ts` — what the wrapper writes, typed by the contract's registry.
 * - `purge.ts` — one purge from trigger to a fresh session in place.
 * - `session.ts` — the wrapper that owns a session's event stream and runs all
 *   of the above at the right moment.
 *
 * Nothing here knows a vendor: a provider enters through `Provider` (§4), the
 * brief and the replayed mail come in through `restart`, and the store is a
 * `record` function.
 */

export * from './peer-state.ts'
export * from './policy.ts'
export * from './purge.ts'
export * from './records.ts'
export * from './session.ts'
export * from './state.ts'
