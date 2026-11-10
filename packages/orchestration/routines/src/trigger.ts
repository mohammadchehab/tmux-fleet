/**
 * When a routine is due (architecture §6). A trigger is data — it comes from
 * the profile, not from code — so "is this due?" has to be one pure function
 * over the trigger, the last run and the clock, testable without a daemon.
 *
 * The clock is the one thing this file must be told, never read: a replay
 * injects the clock recorded with the window (§5.4), and a test injects a
 * fixed one.
 */

import { fleetError } from '@fleet/foundation-core'
import type { FleetEventType, RoutineTrigger } from '@fleet/foundation-contracts'

/**
 * One way a routine can be woken. The `kind` is §6's `routineTriggers`, so a
 * trigger can be recorded verbatim in `routine.started`.
 *
 * - `startup`  — once when the daemon starts (`reconcile`).
 * - `heartbeat` — every `everyMs`, whether or not anything happened (`dispatch`'s 60 s).
 * - `schedule` — once a day at `at`, on the machine's local wall clock (`standup` at 09:00).
 * - `event`    — when the daemon appends one of `types` (`keep-busy` on a peer going idle).
 * - `request`  — only when the user asks (`fleet standup`).
 */
export type Trigger =
  | { readonly kind: 'startup' }
  | { readonly kind: 'heartbeat'; readonly everyMs: number }
  | { readonly kind: 'schedule'; readonly at: string }
  | { readonly kind: 'event'; readonly types: readonly FleetEventType[] }
  | { readonly kind: 'request' }

export const triggerKind = (trigger: Trigger): RoutineTrigger => trigger.kind

/** The triggers the timer evaluates. `event` and `request` are woken, never polled. */
export const isRecurring = (trigger: Trigger): boolean => trigger.kind === 'heartbeat' || trigger.kind === 'schedule'

/** Throws `invalid_input` for anything that is not `HH:MM`. Called at config time, not at 09:00. */
export const assertTimeOfDay = (at: string): void => {
  timeOfDay(at)
}

/** `HH:MM`, 24-hour, on the machine's local clock (§6: "09:00 local"). */
const timeOfDay = (at: string): { readonly hours: number; readonly minutes: number } => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at)
  if (match === null) throw fleetError('invalid_input', `a routine schedule must be "HH:MM", got "${at}"`)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) throw fleetError('invalid_input', `"${at}" is not a time of day`)
  return { hours, minutes }
}

/**
 * The last instant `at` occurred at or before `now`, in milliseconds.
 *
 * Local, deliberately: §6 says 09:00 local, and the clock hands out UTC
 * instants. The conversion happens here, once, so the rest of the code reasons
 * about millis.
 */
export const lastOccurrence = (at: string, now: string): number => {
  const { hours, minutes } = timeOfDay(at)
  const current = new Date(now)
  const occurrence = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
    hours,
    minutes,
    0,
    0,
  )
  // Before today's occurrence there is still yesterday's, which is what makes a
  // daemon that was down overnight catch up on restart.
  if (occurrence.getTime() > current.getTime()) occurrence.setDate(occurrence.getDate() - 1)
  return occurrence.getTime()
}

export interface DueWindow {
  /** When this routine last *completed* a run; absent when it has no recorded run. */
  readonly lastRunAt?: string
  /** The instant being judged, ISO 8601. */
  readonly now: string
}

/**
 * Is the trigger due in this window?
 *
 * A routine with **no recorded run** is due: a profile that has just been
 * created has work waiting on it, and "never run" is the widest miss there is.
 * The one exception is `request`, which never fires on its own.
 *
 * A missed window is caught up **once**, not once per elapsed period: a daemon
 * down for a week runs one standup, because a standup reports the latest state
 * and seven of them would be seven copies of today (§6).
 */
export const isDue = (trigger: Trigger, window: DueWindow): boolean => {
  const now = Date.parse(window.now)
  if (Number.isNaN(now)) throw fleetError('invalid_input', `isDue: "${window.now}" is not an ISO 8601 timestamp`)
  switch (trigger.kind) {
    case 'startup':
      return true
    case 'request':
      return false
    case 'event':
      return false
    case 'heartbeat':
      return window.lastRunAt === undefined || now - Date.parse(window.lastRunAt) >= trigger.everyMs
    case 'schedule':
      return window.lastRunAt === undefined || lastOccurrence(trigger.at, window.now) > Date.parse(window.lastRunAt)
  }
}

/** Did an appended event wake this trigger? */
export const triggeredBy = (trigger: Trigger, type: string): boolean =>
  trigger.kind === 'event' && trigger.types.includes(type as FleetEventType)
