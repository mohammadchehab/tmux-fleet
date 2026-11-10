/**
 * `@fleet/app-cli`: the `fleet` command (§2) — a thin client of `fleetd`'s
 * local API.
 *
 * It imports `foundation` and nothing else, and it holds no state: every
 * answer it prints came over the socket from the daemon in the same call. The
 * daemon's own test drives `run` with a fake caller; `main.ts` is the only
 * file that touches `process`.
 */

export * from './client.ts'
export * from './daemon.ts'
export * from './init.ts'
export * from './render.ts'
export * from './run.ts'
export * from './socket.ts'
