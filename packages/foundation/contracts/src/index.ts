/**
 * `@fleet/foundation-contracts`: the schemas and ports every group shares
 * (architecture §1.1, §3, §4, §7, §12). No behaviour, no I/O: types, schemas
 * and interfaces only, so a group can depend on it without depending on
 * another group.
 */

// provider-facing types (§4, §7, §8)
export * from './provider.ts'

// the domain vocabulary the events and projections share
export * from './work-state.ts'
export * from './shapes.ts'

// the event registry: every type in §3, §5, §6, §7, §8
export * from './events/registry.ts'
export * from './events/peer.ts'
export * from './events/work.ts'
export * from './events/delivery.ts'
export * from './events/messages.ts'
export * from './events/ops.ts'
export * from './events/decisions.ts'
export * from './events/signals.ts'

// projections (§3)
export * from './projections/registry.ts'
export * from './projections/peers.ts'
export * from './projections/work.ts'
export * from './projections/delivery.ts'
export * from './projections/mailbox.ts'
export * from './projections/ops.ts'

// the Mailbox API (§7) and the cross-group ports (§1.1)
export * from './mailbox.ts'
export * from './ports.ts'
