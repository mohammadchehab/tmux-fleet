/**
 * `keep-busy` (§6): a peer went idle, so something should be assignable to it.
 *
 * Two of §6's three sentences are the PM's `assign` rule (§5.2) and the third —
 * "if nothing is ready, create a `sweep` Work for the architect" — is an action
 * too (`raise_no_work`, or a `sweep` Work once `pm` can propose one). So the body
 * is `runTick` and nothing else.
 *
 * TODO(§6, lands with `pm`): the `sweep` fallback needs an action that proposes
 * Work, which §5.2's union does not have yet. A keep-busy run that finds nothing
 * ready reports `actions: 0`, visible in `routine.finished` rather than silent.
 */

import { runTick, type RoutineFactory } from '../routine.ts'

export const keepBusy: RoutineFactory = (deps) => ({
  kind: 'keep-busy',
  run: (context) => runTick(deps, context),
})
