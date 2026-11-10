/**
 * The `worktree-gc` routine's body, married to what only the daemon holds (§6, §9).
 *
 * `@fleet/orchestration-routines` carries the body and its rule; it may import
 * nothing from `integrations` or `workspace` (§1.1). The forge's port, the raw
 * sink, the Mailbox and §9's `Worktrees` live here, so this is the file that
 * builds the factory — `branch-cleanup.ts`, one door over, is the same shape.
 *
 * The scheduler still owns the run: `worktree-gc` is in §6's table, its triggers
 * (a 03:00 schedule and every `work.merged`/`pr.merged`) are in `config.ts`, and
 * its runs are `routine.*` events like any other. Registering it here decides only
 * what the body can reach, never when it wakes.
 *
 * The sink is the raw store: `worktree.removed` is the outcome of a wake, and the
 * routine's own trigger names the merge event, not the removal — routing it
 * through the waking sink would be a routine waking itself for nothing.
 */

import type { EventSink, Mailbox, PullRequests, ReadModel, Worktrees } from '@fleet/foundation-contracts'
import {
  gc,
  type HolderLiveness,
  type RoutineContext,
  type RoutineFactory,
  type RoutineOutcome,
} from '@fleet/orchestration-routines'

/** What the body needs that the scheduler does not hand a routine: the forge, the sink, the box, git (§1.1). */
export interface WorktreeGcWiring {
  readonly pullRequests: PullRequests
  readonly store: EventSink
  readonly mailbox: Mailbox
  /** §9's manager, and the only thing that removes a checkout. */
  readonly worktrees?: Worktrees
  /**
   * How §9 re-asks whether a holder is still running. Defaults to the kernel's
   * answer; a test passes its own, so a suite never depends on a real pid.
   */
  readonly isAlive?: HolderLiveness
}

/** The `worktree-gc` entry of the scheduler's factory map. */
export const createWorktreeGcFactory = (wiring: WorktreeGcWiring): RoutineFactory => (deps) => ({
  kind: 'worktree-gc',
  run: (context) => collect(wiring, deps.read, context),
})

/**
 * One tick, with the two halves kept apart: `read` comes from the scheduler,
 * everything else from the wiring the daemon closed over.
 */
export const collect = async (
  wiring: WorktreeGcWiring,
  read: ReadModel,
  context: RoutineContext,
): Promise<RoutineOutcome> => gc({ read, ...wiring }, context)
