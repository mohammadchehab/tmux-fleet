/**
 * The `branch-cleanup` routine's body, married to what only the daemon holds (§6, §10).
 *
 * `@fleet/orchestration-routines` carries the body and its rules; it may import
 * nothing from `integrations` or `workspace` (§1.1). The forge's port, the raw
 * sink, the Mailbox and §9's `Worktrees` live here, so this is the file that
 * builds the factory — `pr-babysit.ts`, one door over, is the same shape.
 *
 * The scheduler still owns the run: `branch-cleanup` is in §6's table, its
 * triggers (a 04:00 schedule and every `work.merged`/`pr.merged`) are in
 * `config.ts`, and its runs are `routine.*` events like any other.
 *
 * The sink is the raw store: `branch.deleted` is the outcome of a wake, and the
 * routine's own trigger names the merge event, not the deletion — routing it
 * through the waking sink would be a routine waking itself for nothing.
 */

import type { Repo } from '@fleet/foundation-core'
import type { EventSink, Mailbox, PullRequests, ReadModel, Worktrees } from '@fleet/foundation-contracts'
import {
  cleanup,
  type RoutineContext,
  type RoutineFactory,
  type RoutineOutcome,
} from '@fleet/orchestration-routines'

/** What the body needs that the scheduler does not hand a routine: the forge, the sink, the box, git (§1.1). */
export interface BranchCleanupWiring {
  readonly pullRequests: PullRequests
  readonly store: EventSink
  readonly mailbox: Mailbox
  /** §9's manager, for the checkout that goes with a merged branch. */
  readonly worktrees?: Worktrees
  /** The profile's repos: the sweep walks what the fleet may have created (§2). */
  readonly repos: readonly Repo[]
}

/** The `branch-cleanup` entry of the scheduler's factory map. */
export const createBranchCleanupFactory = (wiring: BranchCleanupWiring): RoutineFactory => (deps) => ({
  kind: 'branch-cleanup',
  run: (context) => sweepWiring(wiring, deps.read, context),
})

/**
 * One tick, with the two halves kept apart: `read` comes from the scheduler,
 * everything else from the wiring the daemon closed over.
 */
export const sweepWiring = async (
  wiring: BranchCleanupWiring,
  read: ReadModel,
  context: RoutineContext,
): Promise<RoutineOutcome> => cleanup({ read, ...wiring }, context)
