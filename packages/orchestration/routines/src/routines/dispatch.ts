/**
 * `dispatch` (§5.2, §6): the PM's main loop, on an event or the 60 s heartbeat.
 *
 * The body is the whole routine, because the work is the PM's: §5.2's rules
 * (assign, gate on contract, dedupe, track PR, merge, unblock, idle, stale) are
 * all `decide` acting on a snapshot of the projections, and their effects are
 * `PmAction`s the executor performs. A routine that re-implemented any of them
 * here would be a second copy of the state machine.
 */

import { runTick, type RoutineFactory } from '../routine.ts'

export const dispatch: RoutineFactory = (deps) => ({
  kind: 'dispatch',
  run: (context) => runTick(deps, context),
})
