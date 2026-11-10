/**
 * `@fleet/app-view`: `fleet-view`, a read-only view of the fleet (§2) — one
 * tmux pane per peer, redrawn from `fleetd`'s local API.
 *
 * It imports `foundation` and nothing else, holds no state and decides nothing:
 * a pane is a rendering of the `ls` answer from the tick that drew it. The view
 * never writes to the daemon — the only method it calls is `ls`, so there is no
 * code here that could send a turn, answer a decision or start a fleet.
 *
 * `main.ts` is the only file that touches `process`; the tests drive `parseArgv`,
 * the renderers, the tmux plan and a real socket with no terminal anywhere.
 */

export * from './args.ts'
export * from './client.ts'
export * from './render.ts'
export * from './socket.ts'
export * from './tmux.ts'
export * from './view.ts'
