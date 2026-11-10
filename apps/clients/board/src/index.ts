/**
 * `@fleet/app-board`: `fleet-board`, a read-only web board of the fleet's Work
 * items (§2, §3), served from `fleetd`'s local API.
 *
 * The board answers one question — what Work exists, and what state is it in —
 * by asking the daemon the same thing the rest of the fleet asks, and drawing
 * the answer. It reads two methods, `ls` and `work`, and calls nothing else, so
 * there is no code here that could send a turn, answer a decision or move a
 * Work: a board that could change the fleet would be a second PM.
 *
 * What it renders is the projection's own rows, in the projection's order and
 * unfiltered (§2). Grouping by state is a way of reading that list, not a second
 * opinion about which items exist.
 *
 * `main.ts` is the only file that touches `process`; `render.ts` is a pure
 * function from two answers to a string, and the tests drive it and a real
 * socket with no browser and no terminal anywhere.
 */

export * from './args.ts'
export * from './client.ts'
export * from './render.ts'
export * from './serve.ts'
export * from './socket.ts'
