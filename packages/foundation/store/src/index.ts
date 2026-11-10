/**
 * `@fleet/foundation-store`: the append-only event store (architecture §3, §5.4).
 * `ddl.ts` is the schema as data, `projections.ts` is the one reducer that fills
 * every read model, and `sqlite-store.ts` is the `node:sqlite` implementation of
 * `EventStore` that `apps/daemon` opens.
 */

export * from './ddl.ts'
export * from './store.ts'
export * from './sqlite-store.ts'
export * from './projections.ts'
export { Sqlite } from './sql.ts'
