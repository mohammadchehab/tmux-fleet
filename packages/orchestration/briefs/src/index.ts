/**
 * `@fleet/orchestration-briefs`: a Brief is immutable, versioned per peer, and
 * published once (§12). This package holds the executor for `assign` and
 * `supersede_brief`; the daemon injects the store, the read model and the
 * Mailbox, so nothing here holds a provider or a git handle.
 */

export * from './executor.ts'
export * from './rules.ts'
export * from './standards.ts'
