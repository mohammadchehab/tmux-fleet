/**
 * What a routine *is* (architecture §6): `{id, trigger, run(ctx)}` — and the
 * trigger half lives in `config.ts`, because a routine must not decide when it
 * runs. A body answers one question: "you were woken, what did you do?"
 *
 * The answer is what `routine.finished` records: how many actions the tick
 * decided, and how many of those the fleet could not carry out. A body that
 * returns `0` is a legitimate, visible outcome — the scheduler writes the event
 * either way, which is what makes a silent routine a bug you can see rather
 * than a bug you can only suspect (§6).
 *
 * **The shape of every phase 1 body is the same four steps** (§5.2): load the
 * projections into a `FleetState`, let the PM decide from it, give the actions
 * to the executor, report. That is `runTick` below, and it is the whole of
 * `dispatch`: §5.2's rules are the PM's, and a routine that re-implemented
 * `assign` would be a second copy of the state machine. The bodies still exist
 * per kind because each is the seam for the half of its §6 row that is *not* a
 * PM tick — keep-busy's `sweep` Work, reconcile's provider `status` sweep — and
 * because a run's kind decides which of §6's enemies it is watching for.
 */

import type { Clock, Seq, Timestamp } from '@fleet/foundation-core'
import type {
  ActionExecutor,
  DecideRequest,
  FleetEvent,
  FleetState,
  PmAction,
  ProjectManager,
  ReadModel,
  RoutineKind,
  RoutineTrigger,
} from '@fleet/foundation-contracts'
import { snapshot } from './state.ts'

export interface RoutineContext {
  readonly routineId: string
  readonly kind: RoutineKind
  /** What woke this run; recorded in `routine.started`. */
  readonly trigger: RoutineTrigger
  /** The instant the run started, from the scheduler's injected clock (§5.4). */
  readonly at: Timestamp
  /** The event that woke it, when an event did; a heartbeat, a cron and a start do not. */
  readonly event?: FleetEvent
  /** The scheduler's clock, so a body stamps what it writes with the same time. */
  readonly clock: Clock
}

export interface RoutineOutcome {
  /** How many actions the tick decided; `0` is a legitimate outcome, not an error (§6). */
  readonly actions: number
  /** How many of them the fleet could not carry out (§5.2, §6). */
  readonly actionsFailed: number
  /** The hash of what the tick read, so a run can be traced to a replayable decision (§5.4). */
  readonly inputsHash: string
}

export interface RoutineBody {
  readonly kind: RoutineKind
  run(context: RoutineContext): Promise<RoutineOutcome>
}

/**
 * What a body is handed: the PM's tick (§5.2), the executor that performs what
 * it decides (§5.2), and the projections to take a snapshot of (§3). No store
 * handle, and in particular none of the writes — a routine acts only through
 * the actions the PM decided, so a replay of those decisions reproduces the run.
 */
export interface RoutineBodyDeps {
  readonly pm: ProjectManager
  readonly executor: ActionExecutor
  readonly read: ReadModel
}

export type RoutineFactory = (deps: RoutineBodyDeps) => RoutineBody

/** The `tick` a run hands the PM, built from its context (§5.2). */
export const tickOf = (context: RoutineContext): DecideRequest['tick'] => ({
  at: context.at,
  routineId: context.routineId,
  kind: context.kind,
  trigger: context.trigger,
  ...(context.event === undefined ? {} : { causedBySeq: context.event.seq }),
})

/** The `decide` request a routine's tick makes: the fleet as a value, and what asked (§5.2). */
export const decideRequestOf = (state: FleetState, context: RoutineContext): DecideRequest => ({
  state,
  tick: tickOf(context),
  ...(context.event === undefined ? {} : { event: context.event }),
})

/** What the executor is asked to perform: the decisions, and the run they belong to (§5.2, §6). */
export const executeRequestOf = (
  actions: readonly PmAction[],
  context: RoutineContext,
): { readonly actions: readonly PmAction[]; readonly routineId: string; readonly causedBySeq?: Seq } => ({
  actions,
  routineId: context.routineId,
  ...(context.event === undefined ? {} : { causedBySeq: context.event.seq }),
})

/**
 * The four steps of one routine run (§5.2, §6): load, decide, execute, report.
 *
 * A failure at any step throws, and the scheduler turns it into `routine.failed`
 * — a body does not swallow an error into an `actions: 0`, because a run that
 * did not happen and a run that found nothing are different facts.
 */
export const runTick = async (deps: RoutineBodyDeps, context: RoutineContext): Promise<RoutineOutcome> => {
  const state = await snapshot(deps.read)
  const decided = deps.pm.decide(decideRequestOf(state, context))
  const report = await deps.executor.execute(executeRequestOf(decided.actions, context))
  return { actions: decided.actions.length, actionsFailed: report.failed, inputsHash: decided.inputsHash }
}
