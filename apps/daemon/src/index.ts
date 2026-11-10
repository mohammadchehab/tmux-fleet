/**
 * `@fleet/app-daemon`: `fleetd`, the one place the groups are wired (§2).
 *
 * The exports are the pieces `main.ts` composes and the tests drive
 * separately: the profile reader, the RPC surface, the executor router and the
 * daemon itself. The path layout is not here — it is `profilePaths` in
 * `@fleet/foundation-core`, because the CLI needs the same one.
 */

export * from './config/profile.ts'
export * from './api/rpc.ts'
export * from './execution/executor.ts'
export * from './execution/sessions.ts'
export * from './wiring/daemon.ts'
export * from './api/server.ts'
export * from './wiring/compose.ts'
