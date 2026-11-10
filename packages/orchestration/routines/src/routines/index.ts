/**
 * The routines whose bodies exist. This map is the seam §6 means by "code
 * registered by the daemon, not slash commands": the profile names a routine,
 * the scheduler looks it up here, and nothing in `apps/daemon` mentions a
 * routine by name.
 *
 * A kind missing from this map is not an error — §6 lists eight, phase 1 builds
 * four — it is reported by the scheduler's plan so the daemon can log what is
 * configured and waiting for a body.
 */

import type { RoutineKind } from '@fleet/foundation-contracts'
import type { RoutineFactory } from '../routine.ts'
import { dispatch } from './dispatch.ts'
import { keepBusy } from './keep-busy.ts'
import { reconcile } from './reconcile.ts'
import { standup } from './standup.ts'

export { dispatch, keepBusy, reconcile, standup }

export const installedFactories: Readonly<Partial<Record<RoutineKind, RoutineFactory>>> = {
  dispatch,
  'keep-busy': keepBusy,
  standup,
  reconcile,
}
