/**
 * `@fleet/app-daemon`: `fleetd`, the one place the groups are wired (§2).
 *
 * The exports are the pieces `main.ts` composes and the tests drive
 * separately: the profile reader, the path layout, the RPC surface, the
 * executor router and the daemon itself.
 */

export * from './paths.ts'
export * from './profile.ts'
export * from './rpc.ts'
export * from './executor.ts'
export * from './pm.ts'
export * from './sessions.ts'
export * from './daemon.ts'
export * from './server.ts'
export * from './compose.ts'
