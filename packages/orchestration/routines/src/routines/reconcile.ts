/**
 * `reconcile` (§6): provider `status` against the registry, on startup and every
 * 10 minutes — restart dead sessions, fix drift.
 *
 * What runs today is the PM's tick: drift is visible in the store (a session
 * whose `session.ended` has no successor, a peer whose state and sessions
 * disagree), so `pm` is where it is noticed and where the restart is decided.
 *
 * TODO(§6, lands with `runtime/supervisor`): asking each provider for `status()`
 * and comparing it with the registry (§4) is the supervisor's job. It reaches the
 * PM as a provider event or a port, not as a handle held by a routine; this
 * routine deliberately does not grow one, because a routine that could start
 * sessions would be a second place peers are managed (§2).
 */

import { runTick, type RoutineFactory } from '../routine.ts'

export const reconcile: RoutineFactory = (deps) => ({
  kind: 'reconcile',
  run: (context) => runTick(deps, context),
})
