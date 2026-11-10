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
 *
 * `branch-cleanup` is not in here for `pr-babysit`'s reason, plus one more: it
 * removes a checkout through §9's `Worktrees` port, which only the daemon holds.
 * It is also the first body whose trigger includes an event (`work.merged`), so a
 * profile with no `repos` gets no factory and the branch it would have deleted
 * stays where it is.
 *
 * `worktree-gc` is the same shape and the same seam: it needs §9's manager, the
 * forge (the only voice that can say a PR closed unmerged — §3 has no such event)
 * and a sink for its own facts, so `apps/daemon` registers it and this map stays a
 * map of the bodies that need nothing a routine is not handed.
 */

import type { RoutineKind } from '@fleet/foundation-contracts'
import type { RoutineFactory } from '../routine.ts'
import { cleanup } from './branch-cleanup.ts'
import { dispatch } from './dispatch.ts'
import { keepBusy } from './keep-busy.ts'
import { babysit } from './pr-babysit.ts'
import { reconcile } from './reconcile.ts'
import { standup } from './standup.ts'
import { sync } from './tracker-sync.ts'
import { gc } from './worktree-gc.ts'

export { babysit, cleanup, dispatch, gc, keepBusy, reconcile, standup, sync }
export type { HolderLiveness, WorktreeGcDeps } from './worktree-gc.ts'

export const installedFactories: Readonly<Partial<Record<RoutineKind, RoutineFactory>>> = {
  dispatch,
  'keep-busy': keepBusy,
  standup,
  reconcile,
}
