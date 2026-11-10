/**
 * The `pr-babysit` routine's body, married to what only the daemon holds (§6, §10).
 *
 * `@fleet/orchestration-routines` carries the body and its rules; it may import
 * nothing from `integrations` or `runtime` (§1.1). The forge's port, the sink the
 * facts are appended to and the Mailbox a nudge travels through live here, so this
 * is the file that builds the factory — exactly as `notify.ts` builds its own.
 *
 * The scheduler still owns the run: `pr-babysit` is in §6's table, its triggers
 * (a 5-minute heartbeat and every `pr.*` event) are in `config.ts`, and its runs
 * are `routine.*` events like any other. Registering it here decides only what the
 * body can reach, never when it wakes.
 *
 * The sink is the raw store, not the waking one, for `notify`'s reason: the events
 * this body appends are the outcome of a wake, and a `pr.checks_changed` that woke
 * `pr-babysit` again would be a routine running inside itself (§6).
 */

import type { Repo } from '@fleet/foundation-core'
import type { EventSink, Mailbox, PullRequests, ReadModel } from '@fleet/foundation-contracts'
import {
  babysit,
  type RoutineContext,
  type RoutineFactory,
  type RoutineOutcome,
} from '@fleet/orchestration-routines'

/** What the body needs that the scheduler does not hand a routine: the port, the sink, the box (§1.1). */
export interface PrBabysitWiring {
  readonly pullRequests: PullRequests
  readonly store: EventSink
  readonly mailbox: Mailbox
  /** The profile's repos: a fleet watches the repos it may assign work in (§2). */
  readonly repos: readonly Repo[]
}

/** The `pr-babysit` entry of the scheduler's factory map. */
export const createPrBabysitFactory = (wiring: PrBabysitWiring): RoutineFactory => (deps) => ({
  kind: 'pr-babysit',
  run: (context) => watched(wiring, deps.read, context),
})

/**
 * One tick, with the two halves kept apart: `read` comes from the scheduler,
 * everything else from the wiring the daemon closed over.
 */
export const watched = async (
  wiring: PrBabysitWiring,
  read: ReadModel,
  context: RoutineContext,
): Promise<RoutineOutcome> => babysit({ read, ...wiring }, context)
