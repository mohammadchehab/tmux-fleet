/**
 * The `tracker-sync` routine's body, married to what only the daemon holds
 * (§3, §6).
 *
 * `@fleet/orchestration-routines` carries the body and its rules; it may import
 * nothing from `integrations` (§1.1), so the board's `Tracker` — the one thing
 * the body cannot build — is injected here, the way `pr-babysit` is given the
 * forge. The scheduler still owns the run: `tracker-sync` is in §6's table, its
 * triggers (a 5-minute heartbeat and the three Work events that move a column)
 * live in `config.ts`, and its runs are `routine.*` events like any other.
 *
 * Unlike `pr-babysit`, this body is handed the **waking** sink. Its appends are
 * `work.proposed` and `tracker.synced`, neither of which is a type its own
 * trigger names (§6), and a `work.proposed` that woke nobody would leave a
 * ticket sitting as a Work nobody assigned until the next 60 s dispatch.
 */

import type { ForgeRef } from '@fleet/foundation-core'
import type { EventSink, Tracker } from '@fleet/foundation-contracts'
import { sync, type RoutineContext, type RoutineFactory, type RoutineOutcome } from '@fleet/orchestration-routines'

/** What the body needs that the scheduler does not hand a routine: the port and the sink (§1.1). */
export interface TrackerSyncWiring {
  readonly tracker: Tracker
  readonly store: EventSink
  /** The adapter's name, as `Work.external.system` spells it. */
  readonly system: string
  readonly query: string
  /** The role a proposed Work asks for, when the profile names one (§5.2). */
  readonly role?: string
  /** The profile's `comments`: absent is off — a note is not mirrored unless the profile says so. */
  readonly comments?: boolean
  /** The profile's `forge`: which forge a PR link points at. Absent is GitHub. */
  readonly forge?: ForgeRef
}

/** The `tracker-sync` entry of the scheduler's factory map. */
export const createTrackerSyncFactory = (wiring: TrackerSyncWiring): RoutineFactory => (deps) => ({
  kind: 'tracker-sync',
  run: (context) => watched(wiring, deps.read, context),
})

/** One tick: `read` comes from the scheduler, everything else from the wiring the daemon closed over. */
export const watched = async (
  wiring: TrackerSyncWiring,
  read: Parameters<typeof sync>[0]['read'],
  context: RoutineContext,
): Promise<RoutineOutcome> => sync({ read, ...wiring }, context)
