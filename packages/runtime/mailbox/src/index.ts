/**
 * `@fleet/runtime-mailbox`: the Mailbox implementation behind the API in
 * `@fleet/foundation-contracts` (§7). Nothing outside `apps/daemon` constructs
 * it; everything else takes the `Mailbox` interface.
 */

export * from './mailbox.ts'
