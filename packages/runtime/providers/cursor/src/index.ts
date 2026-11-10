/**
 * `@fleet/runtime-provider-cursor`: architecture §4's `Provider`, implemented on
 * the `cursor-agent` CLI in read-only plan mode.
 *
 * Nothing here imports another provider package: this one is not an SDK
 * wrapper, and the pieces it shares with the others — the queue, the opening
 * message — are small and copied on purpose (§1.1 forbids a provider group from
 * importing sideways for convenience).
 */

export * from './provider.ts'
export * from './stream.ts'
export * from './brief.ts'
export { CursorSession, defaultCursorExecutable, type CursorSessionConfig } from './session.ts'
export { contextLimitFor, usageOf } from './usage.ts'
