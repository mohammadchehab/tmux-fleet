/**
 * `@fleet/foundation-store`: the append-only event store's interface and DDL
 * (architecture §3, §5.4). No implementation in phase 0, and no `node:sqlite`
 * import anywhere in this package yet — the DDL is data, and a test proves it
 * executes.
 */

export * from './ddl.ts'
export * from './store.ts'
