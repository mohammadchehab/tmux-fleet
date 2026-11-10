/**
 * Time is a dependency, not a global (architecture §5.4). The PM and the
 * notification rules are pure functions of events *and the clock*; a replay
 * injects the clock recorded with the window, so `decide` can be re-run.
 */

import type { Timestamp } from './event.ts'

export interface Clock {
  /** The current instant, ISO 8601 UTC. */
  now(): Timestamp
  /** Milliseconds since the epoch; for durations and windows. */
  millis(): number
}

export const isoFromMillis = (millis: number): Timestamp => new Date(millis).toISOString()

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  millis: () => Date.now(),
}

/** A clock frozen at one instant; for tests and for replay. */
export const fixedClock = (at: Timestamp): Clock => {
  const millis = Date.parse(at)
  if (Number.isNaN(millis)) throw new RangeError(`fixedClock: ${at} is not an ISO 8601 timestamp`)
  return { now: () => at, millis: () => millis }
}

/** Whole minutes between two instants, for the PM's idle and reminder windows. */
export const minutesBetween = (from: Timestamp, to: Timestamp): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / 60_000)
