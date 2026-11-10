/**
 * `@fleet/notify-macos`: the first `Notifier` (§6.1). Everything it does is one
 * injected `execFile`, so it is testable without a desktop and inert on a box
 * that is not a Mac.
 */

export * from './macos.ts'
