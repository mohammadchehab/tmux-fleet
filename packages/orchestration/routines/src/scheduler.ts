/**
 * The scheduler (architecture §6): it starts with `fleetd`, registers whatever
 * the profile asks for, and owns the routines from then on. Nothing outside
 * this file names a routine — `apps/daemon` calls `start()`, `wake()` and
 * `stop()` and never learns which routines exist.
 *
 * Five properties, each of which is a test:
 *
 * - **Registered from config.** The plan comes from `planRoutines(config)`; a
 *   routine whose body does not exist yet is reported, not silently dropped.
 * - **Every run is an event.** `routine.started`, then `routine.finished` or
 *   `routine.failed`. A run whose *start* cannot be recorded does not run the
 *   body: an action nobody can see did not happen (§6).
 * - **A run is a decision and its execution.** The body loads a snapshot,
 *   `decide`s against it (§5.2), hands the actions to the `ActionExecutor`
 *   (§10), and reports both counts — `routine.finished.actions` is what the PM
 *   chose, `actionsFailed` is how much of it the world refused.
 * - **Misses are caught up on restart.** A heartbeat or schedule whose window
 *   closed while the daemon was down runs once, not once per period.
 * - **Overlap is prevented per routine.** Two ticks may not run the same
 *   routine at once; the second records a skip.
 * - **The clock is injected.** `durationMs` and every `ts` come from it, so a
 *   test states the time instead of waiting for it (§5.4).
 *
 * A row left in `running` is the projection's way of saying "started, no
 * outcome" (§6) — the previous daemon died mid-run. `start()` turns such a row
 * into a `routine.failed` and runs that routine again: nothing recorded an
 * outcome, so the work was not done.
 */

import {
  fleetError,
  systemClock,
  toFleetError,
  type Clock,
  type FleetError,
  type Seq,
  type Timestamp,
} from '@fleet/foundation-core'
import type {
  ActionExecutor,
  AppendEvent,
  EventSink,
  FleetEvent,
  ProjectManager,
  ReadModel,
  RoutineKind,
  RoutineTrigger,
} from '@fleet/foundation-contracts'
import { planRoutines, type PlannedRoutine, type RoutinesConfig } from './config.ts'
import type { RoutineBody, RoutineFactory } from './routine.ts'
import { installedFactories } from './routines/index.ts'
import { isDue, isRecurring, triggeredBy, type Trigger } from './trigger.ts'

/**
 * The write and read ports are `foundation/contracts`': `EventSink` is the
 * append-only port the Mailbox also writes through (§7), and `RoutineReader` is
 * the `routine` projection, which is how a restarted daemon learns what was
 * missed (§3, §6). Re-exported so a caller reads the scheduler's dependencies
 * from one place.
 */
export type { EventSink }
export type RoutineReader = ReadModel['routines']

/** A timer is a dependency too: a test drives the loop, it does not wait for one. */
export interface Timers {
  setInterval(callback: () => void, everyMs: number): unknown
  clearInterval(handle: unknown): void
}

export const systemTimers: Timers = {
  setInterval: (callback, everyMs) => setInterval(callback, everyMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * Everything a routine body may reach: the PM that decides (§5.2), the executor
 * that carries the decision out (§10), and the read model it snapshots first.
 * No routine gets a store handle — a decision is not a write, and the executor
 * is the only thing that appends (§5.2's `decide → execute → events`).
 */
export interface SchedulerDeps {
  readonly store: EventSink
  readonly read: ReadModel
  readonly pm: ProjectManager
  readonly executor: ActionExecutor
  readonly config?: RoutinesConfig
  readonly clock?: Clock
  readonly timers?: Timers
  /** How often the timer evaluates heartbeats and schedules; 5 s is under the shortest default (60 s). */
  readonly tickIntervalMs?: number
  /** Body lookup. Defaults to the phase 1 set; a test passes one routine. */
  readonly factories?: Readonly<Partial<Record<RoutineKind, RoutineFactory>>>
  /**
   * Unexpected failures — a failed read of the projection, not a failed routine
   * (those are `routine.failed` events). The timer's callback cannot throw into
   * anything, so without this a broken loop would be silent.
   */
  readonly onError?: (error: unknown) => void
}

/** What one run did. Returned by every entry point so a caller can log or assert on it. */
export interface RunRecord {
  readonly routineId: string
  readonly kind: RoutineKind
  readonly trigger: RoutineTrigger
  /** How many actions the PM decided (§5.2). */
  readonly actions: number
  /** How many of those the executor could not carry out (§6's `routine.finished.actionsFailed`). */
  readonly actionsFailed: number
  /** The decision's inputs (§5.4); absent when the body never decided — a skip or a failure before `decide`. */
  readonly inputsHash?: string
  readonly durationMs: number
  readonly ok: boolean
  /** Why it failed, when it did. Also what `routine.failed` carries. */
  readonly error?: string
  /** The previous run of this routine was still in flight (§6). */
  readonly skipped: boolean
}

export interface SchedulerPlan {
  /** Every routine the profile enables, in §6's order. */
  readonly routines: readonly PlannedRoutine[]
  /** Those with a body, which is what actually runs. */
  readonly installed: readonly RoutineKind[]
  /** Enabled, but no body yet — logged by the daemon so it is not a silent gap. */
  readonly unimplemented: readonly RoutineKind[]
}

export interface Scheduler {
  readonly plan: SchedulerPlan
  /** Register, catch up on what was missed, then start the timer. Returns what it ran. */
  start(): Promise<readonly RunRecord[]>
  stop(): void
  /**
   * Evaluate heartbeats and schedules once; the timer calls this, and so do
   * tests. Due routines run one after another, in §6's order — a slow routine
   * delays the rest of *its* tick, never a second copy of itself (§6 forbids
   * overlap per routine, not globally).
   */
  tick(): Promise<readonly RunRecord[]>
  /** An event was appended: wake whatever listens for that type (§5.2: a tick per event, not a poll). */
  wake(event: FleetEvent): Promise<readonly RunRecord[]>
  /** The user asked for a routine by name (`fleet standup`): the run is an event like any other (§6). */
  request(routineId: string): Promise<RunRecord>
}

const MAX_ERROR = 2000

/** The longest a retry is held off for a routine whose own period gives no better answer (§6). */
const HOUR_MS = 60 * 60 * 1000
/** A daily routine's period, which is what a daily routine's backoff may grow to (§6). */
const DAY_MS = 24 * HOUR_MS
/** Failures in a row that mean "broken", not "unlucky" — the one that is worth a banner (§6, §6.1). */
const ESCALATE_AFTER = 3

/**
 * One routine's run of failures, as the scheduler remembers it between ticks
 * (§6). `lastRun` moves on a failure as well (`#134`), which is what keeps a
 * broken routine off the very next tick; this is what says how many failures in
 * a row it has had, and so how far the next retry is pushed out.
 */
interface Attempt {
  /** Attempts in a row that ended in a failure, this one included. */
  readonly failures: number
  /** When the last attempt ended, successful or not, in millis: the backoff is measured from here. */
  readonly atMillis: number
  /** The error the last attempt failed with. A *different* one is worth saying again (§6.1). */
  readonly error: string
  /** The error the last escalation named, which is what keeps a repeat from ringing twice (§6.1). */
  readonly escalated?: string
}

/** `text(2000)`: an error message is appended, so it is trimmed at the schema's edge, not by luck. */
const messageOf = (error: FleetError): string => {
  const text = error.code === 'internal' ? error.message : `${error.code}: ${error.message}`
  return text.length <= MAX_ERROR ? text : `${text.slice(0, MAX_ERROR - 1)}…`
}

export const createScheduler = (deps: SchedulerDeps): Scheduler => {
  const clock = deps.clock ?? systemClock
  const timers = deps.timers ?? systemTimers
  const factories = deps.factories ?? installedFactories
  const tickIntervalMs = deps.tickIntervalMs ?? 5_000

  const planned = planRoutines(deps.config)
  const installed = planned.filter((routine) => factories[routine.kind] !== undefined)
  const bodies = new Map<string, RoutineBody>(
    installed.map((routine) => [
      routine.id,
      (factories[routine.kind] as RoutineFactory)({ pm: deps.pm, executor: deps.executor, read: deps.read }),
    ]),
  )

  /**
   * When each routine last *ran* — finished, failed, or was found interrupted —
   * the window `isDue` is judged against. Seeded from the projection, which
   * records `lastRunAt` on all three, so the memory here has to say what the log
   * says: a run that failed happened, and its routine is next due at its own
   * period rather than on the very next tick.
   */
  const lastRun = new Map<string, Timestamp>()
  /** The last *attempt* of each failing routine, which spaces its retries out (§6). */
  const attempts = new Map<string, Attempt>()
  /** The per-routine overlap guard (§6). Checked and set synchronously, before any await. */
  const inFlight = new Set<string>()
  let timer: unknown
  let started = false

  const plan: SchedulerPlan = {
    routines: planned,
    installed: installed.map((routine) => routine.kind),
    unimplemented: planned
      .filter((routine) => factories[routine.kind] === undefined)
      .map((routine) => routine.kind),
  }

  const windowOf = (routineId: string, now: Timestamp): { readonly lastRunAt?: Timestamp; readonly now: Timestamp } => {
    const last = lastRun.get(routineId)
    return last === undefined ? { now } : { lastRunAt: last, now }
  }

  /**
   * The routine's own period, in millis — what its window already waits between
   * runs, and so the shortest a retry may be spaced (§6). A `schedule` fires
   * once a day; a heartbeat every `everyMs`; a routine that only listens for
   * events has no period of its own, so nothing to wait out.
   */
  const periodMs = (routine: PlannedRoutine): number => {
    let period = 0
    for (const trigger of routine.triggers) {
      if (trigger.kind === 'schedule') period = Math.max(period, DAY_MS)
      if (trigger.kind === 'heartbeat') period = Math.max(period, trigger.everyMs)
    }
    return period
  }

  /**
   * How long a failing routine waits before its next attempt (§6): the doubling
   * from the tick interval — `tick`, `2×tick`, `4×tick`, … capped at an hour —
   * and never shorter than the routine's own period. So the backoff only ever
   * *lengthens* a retry past the period: a broken daily routine still runs at
   * most once a day, and a broken heartbeat backs off from its minute towards
   * the hour instead of being retried every tick. `failures` is how many
   * attempts in a row have failed — the delay before the next one.
   */
  const backoffMs = (routine: PlannedRoutine, failures: number): number => {
    let doubling = tickIntervalMs
    for (let doubled = 0; doubled < failures && doubling < HOUR_MS; doubled += 1) doubling *= 2
    return Math.max(periodMs(routine), Math.min(doubling, HOUR_MS))
  }

  /** Whether the last failed attempt still holds this routine's next try off (§6). */
  const retryDue = (routine: PlannedRoutine, now: Timestamp): boolean => {
    const attempt = attempts.get(routine.id)
    if (attempt === undefined) return true
    return Date.parse(now) - attempt.atMillis >= backoffMs(routine, attempt.failures)
  }

  const startedEvent = (
    routine: PlannedRoutine,
    trigger: RoutineTrigger,
    ts: Timestamp,
    causedBySeq: Seq | undefined,
  ): AppendEvent => ({
    type: 'routine.started',
    ts,
    subject: routine.id,
    actor: 'scheduler',
    data: {
      routineId: routine.id,
      kind: routine.kind,
      trigger,
      ...(causedBySeq === undefined ? {} : { causedBySeq }),
    },
  })

  const failedEvent = (routine: PlannedRoutine, ts: Timestamp, error: string): AppendEvent => ({
    type: 'routine.failed',
    ts,
    subject: routine.id,
    actor: 'scheduler',
    data: { routineId: routine.id, kind: routine.kind, error },
  })

  /** The escalation (§6.1): a routine that is broken, with what broke and when it is tried again. */
  const failingEvent = (
    routine: PlannedRoutine,
    ts: Timestamp,
    error: string,
    failures: number,
    retryAt: Timestamp,
  ): AppendEvent => ({
    type: 'routine.failing',
    ts,
    subject: routine.id,
    actor: 'scheduler',
    data: { routineId: routine.id, kind: routine.kind, error, failures, retryAt },
  })

  /**
   * Remember an attempt that failed, and answer whether it is one to say out
   * loud (§6, §6.1). The escalation is written on the third failure in a row and
   * then only when the error itself changes: a routine whose remote is down
   * answers the same way every time, and a banner per retry is the spam §6.1
   * exists to prevent.
   */
  const recordFailure = (routine: PlannedRoutine, at: Timestamp, error: string): AppendEvent | undefined => {
    const previous = attempts.get(routine.id)
    const failures = (previous?.failures ?? 0) + 1
    const escalate = failures >= ESCALATE_AFTER && previous?.escalated !== error
    const escalated = escalate ? error : previous?.escalated
    const atMillis = Date.parse(at)
    attempts.set(routine.id, {
      failures,
      atMillis,
      error,
      ...(escalated === undefined ? {} : { escalated }),
    })
    // The next try is what the banner promises, so it is computed from the same
    // backoff the tick will judge the retry against — not estimated again there.
    return escalate
      ? failingEvent(routine, at, error, failures, new Date(atMillis + backoffMs(routine, failures)).toISOString())
      : undefined
  }

  const finishedEvent = (
    routine: PlannedRoutine,
    ts: Timestamp,
    durationMs: number,
    actions: number,
    actionsFailed: number,
  ): AppendEvent => ({
    type: 'routine.finished',
    ts,
    subject: routine.id,
    actor: 'scheduler',
    data: { routineId: routine.id, kind: routine.kind, durationMs, actions, actionsFailed },
  })

  const skip = (routine: PlannedRoutine, trigger: RoutineTrigger): RunRecord => ({
    routineId: routine.id,
    kind: routine.kind,
    trigger,
    actions: 0,
    actionsFailed: 0,
    durationMs: 0,
    ok: true,
    skipped: true,
  })

  const run = async (
    routine: PlannedRoutine,
    trigger: RoutineTrigger,
    event?: FleetEvent,
  ): Promise<RunRecord> => {
    // The overlap guard runs before the first await, so two ticks cannot both
    // get past it (§6: overlap is prevented per routine).
    if (inFlight.has(routine.id)) return skip(routine, trigger)
    inFlight.add(routine.id)
    try {
      const startedMillis = clock.millis()
      const at = clock.now()
      const record = (
        fields: Pick<RunRecord, 'actions' | 'actionsFailed' | 'durationMs' | 'ok'> & {
          inputsHash?: string
          error?: string
        },
      ): RunRecord => ({
        routineId: routine.id,
        kind: routine.kind,
        trigger,
        skipped: false,
        ...fields,
      })

      try {
        await deps.store.append([startedEvent(routine, trigger, at, event?.seq)])
      } catch (thrown) {
        // A run that cannot be seen must not happen: refuse the body rather than
        // act invisibly (§6).
        const error = messageOf(toFleetError(thrown, 'store_failed'))
        // Still an attempt that failed, so it still spaces the next one out. The
        // escalation is dropped rather than appended: the store just refused a
        // write, and a second one would only fail the same way.
        recordFailure(routine, clock.now(), error)
        return record({
          actions: 0,
          actionsFailed: 0,
          durationMs: 0,
          ok: false,
          error,
        })
      }

      const body = bodies.get(routine.id) as RoutineBody
      let actions: number
      let actionsFailed: number
      let inputsHash: string
      try {
        const outcome = await body.run({
          routineId: routine.id,
          kind: routine.kind,
          trigger,
          at,
          clock,
          ...(event === undefined ? {} : { event }),
        })
        actions = outcome.actions
        actionsFailed = outcome.actionsFailed
        inputsHash = outcome.inputsHash
      } catch (thrown) {
        const error = messageOf(toFleetError(thrown))
        const failedAt = clock.now()
        const failing = recordFailure(routine, failedAt, error)
        // The failure and its escalation go in one batch: a banner that outran
        // the fact it is about would be the ledger telling two stories (§6, §6.1).
        await deps.store.append([
          failedEvent(routine, failedAt, error),
          ...(failing === undefined ? [] : [failing]),
        ])
        // A failed run is a run: the projection stamps `lastRunAt` with it
        // (`projections.ts`, `routine.failed`) and a restart seeds `lastRun` from
        // that row, so the map and the log must agree here too — leaving it unset
        // is what made a broken routine due on every tick (#132).
        lastRun.set(routine.id, failedAt)
        return record({
          actions: 0,
          actionsFailed: 0,
          durationMs: clock.millis() - startedMillis,
          ok: false,
          error,
        })
      }

      const finishedAt = clock.now()
      const durationMs = clock.millis() - startedMillis
      await deps.store.append([finishedEvent(routine, finishedAt, durationMs, actions, actionsFailed)])
      lastRun.set(routine.id, finishedAt)
      // It recovered, so the next failure is a first failure again — and if it
      // ever reaches three, worth a banner of its own (§6.1).
      attempts.delete(routine.id)
      return record({ actions, actionsFailed, inputsHash, durationMs, ok: true })
    } finally {
      inFlight.delete(routine.id)
    }
  }

  const tick = async (): Promise<readonly RunRecord[]> => {
    const now = clock.now()
    const records: RunRecord[] = []
    for (const routine of installed) {
      // A routine runs at most once per tick, however many of its triggers are
      // due — and a routine that just failed also waits out its backoff (§6).
      //
      // Both gates are needed and neither subsumes the other: `lastRun` moves on
      // a failure too (the projection stamps `lastRunAt` with it), so the window
      // is what stops the next tick from being due; the backoff is what spaces
      // the retries *beyond* the window once the failures pile up. The backoff is
      // never shorter than the window, so the later of the two wins.
      //
      // The trigger that fires is the first *due* recurring one, not the first
      // recurring one: a routine with a schedule and a heartbeat must run when
      // only the later of them is due, and say which one it was.
      const due = routine.triggers.find((trigger) => isRecurring(trigger) && isDue(trigger, windowOf(routine.id, now)))
      if (due !== undefined && retryDue(routine, now)) records.push(await run(routine, due.kind))
    }
    return records
  }

  const wake = async (event: FleetEvent): Promise<readonly RunRecord[]> => {
    const records: RunRecord[] = []
    for (const routine of installed) {
      // Deliberately not gated by `retryDue`: the backoff spaces the *poll* of a
      // routine that keeps failing, and an event is not a poll. Something real
      // happened, and it gets one honest try (§6).
      const listens = routine.triggers.some((trigger: Trigger) => triggeredBy(trigger, event.type))
      if (listens) records.push(await run(routine, 'event', event))
    }
    return records
  }

  const request = async (routineId: string): Promise<RunRecord> => {
    const routine = installed.find((candidate) => candidate.id === routineId)
    if (routine === undefined) {
      throw fleetError(
        'invalid_input',
        `no routine "${routineId}" is installed; installed: ${plan.installed.join(', ')}`,
      )
    }
    return run(routine, 'request')
  }

  const start = async (): Promise<readonly RunRecord[]> => {
    if (started) return []
    started = true
    const at = clock.now()
    const rows = new Map((await deps.read.routines.all()).map((row) => [row.routineId, row]))
    const records: RunRecord[] = []
    const ran = new Set<string>()

    // A row still `running` means a previous daemon died mid-run: say so, then
    // re-run it at startup, since nothing recorded an outcome.
    for (const routine of installed) {
      const row = rows.get(routine.id)
      if (row === undefined) continue
      if (row.state === 'running') {
        await deps.store.append([
          failedEvent(routine, at, 'interrupted: the daemon restarted while this run was in flight'),
        ])
        records.push(await run(routine, 'startup'))
        ran.add(routine.id)
      } else if (row.lastRunAt !== undefined) {
        lastRun.set(routine.id, row.lastRunAt)
      }
    }

    // `startup` triggers fire here and only here.
    for (const routine of installed) {
      if (ran.has(routine.id)) continue
      if (routine.triggers.some((trigger) => trigger.kind === 'startup')) {
        records.push(await run(routine, 'startup'))
        ran.add(routine.id)
      }
    }

    // Catch up what closed while the daemon was down — once per routine (§6).
    for (const routine of installed) {
      if (ran.has(routine.id)) continue
      const due = routine.triggers.find((trigger) => isRecurring(trigger) && isDue(trigger, windowOf(routine.id, at)))
      if (due !== undefined && retryDue(routine, at)) {
        records.push(await run(routine, due.kind))
        ran.add(routine.id)
      }
    }

    timer = timers.setInterval(() => {
      void tick().catch((error: unknown) => deps.onError?.(error))
    }, tickIntervalMs)
    return records
  }

  const stop = (): void => {
    if (timer !== undefined) timers.clearInterval(timer)
    timer = undefined
    started = false
  }

  return { plan, start, stop, tick, wake, request }
}
