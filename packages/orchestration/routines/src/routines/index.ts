/**
 * The routines whose bodies exist. This map is the seam §6 means by "code
 * registered by the daemon, not slash commands": the profile names a routine,
 * the scheduler looks it up here, and nothing in `apps/daemon` mentions a
 * routine by name.
 *
 * A kind missing from this map is not an error — §6 lists eight, and this map
 * holds the four whose body is a PM tick — it is reported by the scheduler's
 * plan, so the daemon can log what is configured and waiting for a body.
 *
 * `tracker-sync` is one of those too, for the other side of the same reason: it
 * is a third body (after `notify` and `security-scan`) that needs a port the
 * scheduler does not hand a routine — the board's `Tracker` — so `apps/daemon`
 * registers it, and a profile with no `trackers` block gets no such routine.
 *
 * `pr-babysit` is the other body that exists and is deliberately not in here:
 * it needs the forge's port, a sink and a mailbox, none of which the scheduler
 * hands a routine, so `apps/daemon` registers it the way it registers `notify`
 * (§1.1).
 */

import type { RoutineKind } from '@fleet/foundation-contracts'
import type { RoutineFactory } from '../routine.ts'
import { dispatch } from './dispatch.ts'
import { keepBusy } from './keep-busy.ts'
import { babysit } from './pr-babysit.ts'
import { reconcile } from './reconcile.ts'
import { standup } from './standup.ts'
import { sync } from './tracker-sync.ts'

export { babysit, dispatch, keepBusy, reconcile, standup, sync }

export const installedFactories: Readonly<Partial<Record<RoutineKind, RoutineFactory>>> = {
  dispatch,
  'keep-busy': keepBusy,
  standup,
  reconcile,
}
