/**
 * `@fleet/notify-core`: §6.1's notification rules and the `Notifier` port.
 * Channels (`notify/channels/macos`) implement the port and import these types
 * and nothing else from the rest of the fleet; the `notify` routine (§6) calls
 * `runNotify` and appends the events it produces.
 */

export * from './notifier.ts'
export * from './policy.ts'
export * from './plan.ts'
export * from './deliver.ts'
export * from './run.ts'
