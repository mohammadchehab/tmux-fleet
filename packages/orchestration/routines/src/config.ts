/**
 * The routines a profile asks for (architecture §6). Nothing here is
 * hand-wired: the daemon hands the profile's `routines` block to
 * `planRoutines`, and whatever comes back is what the scheduler owns. A
 * routine that is not in §6's table cannot be configured, and one that is
 * configured but has no body yet is reported rather than silently dropped.
 */

import { fleetError } from '@fleet/foundation-core'
import { routineKinds, type RoutineKind } from '@fleet/foundation-contracts'
import { assertTimeOfDay, type Trigger } from './trigger.ts'

/** Per-profile settings for one routine. "The defaults are all on", so silence means enabled (§6). */
export interface RoutineSettings {
  readonly enabled?: boolean
  /** A heartbeat's period, in whole minutes. */
  readonly everyMinutes?: number
  /** A daily schedule's time, `HH:MM` on the machine's local clock. */
  readonly at?: string
}

/**
 * The profile's `routines` block, one entry per kind. Partial, so a profile
 * names only what it changes; a kind it does not name keeps §6's default.
 *
 * The file's block and this type are the same shape on purpose: an earlier
 * version wrapped it one level deeper (`{routines: {...}}`), which made the
 * documented spelling `routines: {dispatch: {enabled: false}}` decode into an
 * object whose every routine was `undefined` — every routine then ran with its
 * defaults, and the profile looked like it had turned them off.
 */
export type RoutinesConfig = Partial<Record<RoutineKind, RoutineSettings>>

/** A routine as the scheduler will run it: its id, its kind, and every way it can be woken. */
export interface PlannedRoutine {
  readonly id: string
  readonly kind: RoutineKind
  readonly triggers: readonly Trigger[]
}

/**
 * §6's table, as data. The event lists are the ones the routine's row names:
 * `dispatch` wants anything that could make work assignable, `keep-busy` wants
 * peers going idle, `pr-babysit` wants PR movement, `reconcile` wants nothing
 * but the clock and startup.
 */
export const defaultTriggers: Readonly<Record<RoutineKind, readonly Trigger[]>> = {
  dispatch: [
    { kind: 'heartbeat', everyMs: 60_000 },
    {
      kind: 'event',
      types: [
        'work.proposed',
        'work.ready',
        // `work.mergeable` is the moment §10's `merge` rule has something to do, and
        // `work.merged` is the moment it no longer does. Without them the PM would
        // only get to a green PR on the 60 s heartbeat — up to a minute of a Work
        // sitting mergeable while nothing asks the gate, which is the wake §6 exists
        // to avoid.
        'work.mergeable',
        'work.merged',
        // A `blocked` note is the one phase a peer reports that the PM must answer, and the
        // note is recorded-only — the heartbeat after it has the Work but not the words.
        // This line is what lets the tick that carries the note raise the decision.
        'work.noted',
        'peer.registered',
        'peer.state_changed',
        'contract.published',
      ],
    },
  ],
  'keep-busy': [{ kind: 'event', types: ['peer.state_changed'] }],
  'pr-babysit': [
    { kind: 'heartbeat', everyMs: 300_000 },
    { kind: 'event', types: ['pr.opened', 'pr.checks_changed', 'pr.review_changed', 'pr.merged'] },
  ],
  standup: [
    { kind: 'schedule', at: '09:00' },
    { kind: 'request' },
  ],
  'worktree-gc': [
    { kind: 'schedule', at: '03:00' },
    { kind: 'event', types: ['work.merged', 'pr.merged'] },
  ],
  // §10: a merge is the moment the head branch may go, and the nightly sweep is
  // what finds the ones merged while this routine was down or merged by hand. The
  // event half never waits for the sweep, because a dependent arriving in between
  // is exactly what the delete's pin exists to catch.
  'branch-cleanup': [
    { kind: 'schedule', at: '04:00' },
    { kind: 'event', types: ['work.merged', 'pr.merged'] },
  ],
  reconcile: [
    { kind: 'startup' },
    { kind: 'heartbeat', everyMs: 600_000 },
  ],
  'security-scan': [
    { kind: 'schedule', at: '02:00' },
    { kind: 'event', types: ['pr.opened'] },
  ],
  // §3: the board polled on a heartbeat, and the Work's own movement echoed back
  // on the three events that mean a column changed. The pull is a heartbeat and
  // not a schedule because a board is a queue: five minutes of a ticket nobody
  // picked up is the difference the sync exists to remove.
  'tracker-sync': [
    { kind: 'heartbeat', everyMs: 300_000 },
    // `work.noted` is in the list because a note is a sink event with no state
    // to move: woken by the heartbeat it would be a pull, and the note would
    // never reach the card. The types this routine appends (`work.proposed`,
    // `tracker.synced`) are not among them, so the wake cannot re-enter it (§6).
    { kind: 'event', types: ['work.started', 'work.review_requested', 'work.merged', 'work.noted'] },
  ],
  notify: [
    { kind: 'heartbeat', everyMs: 300_000 },
    {
      kind: 'event',
      types: ['decision.requested', 'peer.failed', 'ci.failed_final', 'provider.errored', 'standup.rendered'],
    },
  ],
}

const positiveMinutes = (kind: RoutineKind, value: number): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw fleetError('invalid_input', `routine "${kind}": everyMinutes must be a positive whole number, got ${value}`)
  }
  return value * 60_000
}

/** Apply a profile's overrides to §6's default triggers, keeping the ones it does not touch. */
const resolveTriggers = (kind: RoutineKind, settings: RoutineSettings | undefined): readonly Trigger[] => {
  if (settings === undefined) return defaultTriggers[kind]
  let triggers = defaultTriggers[kind]

  if (settings.everyMinutes !== undefined) {
    const everyMs = positiveMinutes(kind, settings.everyMinutes)
    const hasHeartbeat = triggers.some((trigger) => trigger.kind === 'heartbeat')
    triggers = hasHeartbeat
      ? triggers.map((trigger) => (trigger.kind === 'heartbeat' ? { kind: 'heartbeat', everyMs } : trigger))
      : [...triggers, { kind: 'heartbeat', everyMs }]
  }

  if (settings.at !== undefined) {
    const at = settings.at
    // Throws here, at config time, and not at 09:00 tomorrow.
    assertTimeOfDay(at)
    const hasSchedule = triggers.some((trigger) => trigger.kind === 'schedule')
    triggers = hasSchedule
      ? triggers.map((trigger) => (trigger.kind === 'schedule' ? { kind: 'schedule', at } : trigger))
      : [...triggers, { kind: 'schedule', at }]
  }

  return triggers
}

/**
 * What the profile installs, in §6's order. Throws `invalid_input` for a
 * routine kind the fleet does not have, because a typo in a profile that
 * silently does nothing is a routine that quietly never runs.
 */
export const planRoutines = (config: RoutinesConfig = {}): readonly PlannedRoutine[] => {
  const settings = config
  for (const key of Object.keys(settings)) {
    if (!(routineKinds as readonly string[]).includes(key)) {
      throw fleetError('invalid_input', `unknown routine "${key}"; the fleet has: ${routineKinds.join(', ')}`)
    }
  }
  return routineKinds
    .filter((kind) => settings[kind]?.enabled !== false)
    .map((kind) => ({ id: kind, kind, triggers: resolveTriggers(kind, settings[kind]) }))
}
