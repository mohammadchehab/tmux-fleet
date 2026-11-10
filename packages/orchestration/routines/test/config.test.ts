/**
 * §6's "registers the routines from config, with nothing hand-wired": these
 * tests are about the profile, not about the scheduler. The defaults are all on,
 * a profile names only what it changes, and a typo fails loudly.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fleetErrorCodes } from '@fleet/foundation-core'
import { routineKinds } from '@fleet/foundation-contracts'
import { defaultTriggers, planRoutines } from '../src/config.ts'
import { isDue, lastOccurrence } from '../src/trigger.ts'

const kindsOf = (ids: readonly { readonly kind: string }[]): readonly string[] => ids.map((entry) => entry.kind)

describe('the defaults are all on', () => {
  it('plans every routine in §6, in its order, with no config at all', () => {
    assert.deepEqual(kindsOf(planRoutines()), routineKinds)
  })

  it('gives each routine the triggers §6 names', () => {
    const planned = planRoutines()
    const triggersOf = (kind: string): readonly string[] =>
      (planned.find((routine) => routine.kind === kind)?.triggers ?? []).map((trigger) => trigger.kind)

    assert.deepEqual(triggersOf('dispatch'), ['heartbeat', 'event'])
    assert.deepEqual(triggersOf('keep-busy'), ['event'])
    assert.deepEqual(triggersOf('standup'), ['schedule', 'request'])
    assert.deepEqual(triggersOf('reconcile'), ['startup', 'heartbeat'])
  })

  it('has a dispatch heartbeat of 60 s and a reconcile heartbeat of 10 min', () => {
    const heartbeat = (kind: string): number | undefined => {
      const trigger = defaultTriggers[kind as keyof typeof defaultTriggers].find(
        (candidate) => candidate.kind === 'heartbeat',
      )
      return trigger?.kind === 'heartbeat' ? trigger.everyMs : undefined
    }
    assert.equal(heartbeat('dispatch'), 60_000)
    assert.equal(heartbeat('reconcile'), 600_000)
  })

  it('wakes dispatch on work.noted, so a blocked note is answered on the tick that carries it', () => {
    const event = defaultTriggers.dispatch.find((trigger) => trigger.kind === 'event')
    assert.ok(event?.kind === 'event')
    // §5.1: the note is recorded-only — no projection keeps it — so the heartbeat that follows has
    // the Work but not the words. `work.noted` is the only wake the blocked-note rule can have.
    assert.ok(event.types.includes('work.noted'), `dispatch is woken by ${event.types.join(', ')}`)
  })

  it('wakes tracker-sync on work.noted, which is the only way a note reaches a card', () => {
    const event = defaultTriggers['tracker-sync'].find((trigger) => trigger.kind === 'event')
    assert.ok(event?.kind === 'event')
    // A note is a sink event and not a heartbeat's business: the pull half of the
    // routine asks the board what it has, and the board cannot tell it a note.
    assert.ok(event.types.includes('work.noted'), `tracker-sync is woken by ${event.types.join(', ')}`)
  })

  it('schedules the standup at 09:00', () => {
    const standup = defaultTriggers.standup.find((trigger) => trigger.kind === 'schedule')
    assert.equal(standup?.kind === 'schedule' ? standup.at : undefined, '09:00')
  })
})

describe('a profile names only what it changes', () => {
  it('leaves everything it does not mention enabled', () => {
    const planned = planRoutines({ standup: { at: '07:30' } })
    assert.deepEqual(kindsOf(planned), routineKinds)
  })

  it('removes a routine that is disabled', () => {
    const planned = planRoutines({ 'security-scan': { enabled: false }, notify: { enabled: false } })
    assert.deepEqual(kindsOf(planned), routineKinds.filter((kind) => kind !== 'security-scan' && kind !== 'notify'))
  })

  it('overrides a heartbeat period in place', () => {
    const dispatch = planRoutines({ dispatch: { everyMinutes: 5 } }).find(
      (routine) => routine.kind === 'dispatch',
    )
    const heartbeat = dispatch?.triggers.find((trigger) => trigger.kind === 'heartbeat')
    assert.equal(heartbeat?.kind === 'heartbeat' ? heartbeat.everyMs : undefined, 300_000)
    // The event trigger survives an override of a different trigger.
    assert.equal(dispatch?.triggers.filter((trigger) => trigger.kind === 'event').length, 1)
  })

  it('overrides a schedule in place', () => {
    const standup = planRoutines({ standup: { at: '07:30' } }).find(
      (routine) => routine.kind === 'standup',
    )
    const schedule = standup?.triggers.find((trigger) => trigger.kind === 'schedule')
    assert.equal(schedule?.kind === 'schedule' ? schedule.at : undefined, '07:30')
  })

  it('adds a trigger a routine does not have by default', () => {
    const keepBusy = planRoutines({ 'keep-busy': { everyMinutes: 15 } }).find(
      (routine) => routine.kind === 'keep-busy',
    )
    assert.deepEqual(
      keepBusy?.triggers.map((trigger) => trigger.kind),
      ['event', 'heartbeat'],
    )
  })
})

describe('a bad profile fails at config time', () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn()
    } catch (thrown) {
      const error = thrown as { code?: string }
      assert.ok(fleetErrorCodes.includes(error.code as never), `expected a FleetError code, got ${String(error.code)}`)
      return String(error.code)
    }
    assert.fail('expected the config to be refused')
  }

  it('refuses a routine the fleet does not have', () => {
    assert.equal(codeOf(() => planRoutines({ dispatchh: { enabled: true } } as never)), 'invalid_input')
  })

  it('refuses an unparseable schedule', () => {
    assert.equal(codeOf(() => planRoutines({ standup: { at: '9am' } })), 'invalid_input')
  })

  it('refuses a schedule that is not a time of day', () => {
    assert.equal(codeOf(() => planRoutines({ standup: { at: '24:00' } })), 'invalid_input')
  })

  it('refuses a heartbeat of zero or a fraction of a minute', () => {
    assert.equal(codeOf(() => planRoutines({ dispatch: { everyMinutes: 0 } })), 'invalid_input')
    assert.equal(codeOf(() => planRoutines({ dispatch: { everyMinutes: 1.5 } })), 'invalid_input')
  })
})

describe('the clock decides what is due', () => {
  it('runs a routine that has no recorded run', () => {
    assert.equal(isDue({ kind: 'heartbeat', everyMs: 60_000 }, { now: '2026-11-10T09:00:00.000Z' }), true)
    assert.equal(isDue({ kind: 'schedule', at: '09:00' }, { now: '2026-11-10T09:00:00.000Z' }), true)
  })

  it('waits a full heartbeat before running again', () => {
    const trigger = { kind: 'heartbeat', everyMs: 60_000 } as const
    assert.equal(
      isDue(trigger, { lastRunAt: '2026-11-10T08:59:01.000Z', now: '2026-11-10T09:00:00.000Z' }),
      false,
    )
    assert.equal(
      isDue(trigger, { lastRunAt: '2026-11-10T08:59:00.000Z', now: '2026-11-10T09:00:00.000Z' }),
      true,
    )
  })

  it('catches up a schedule that closed while the daemon was down — once, not once per day', () => {
    const at = new Date(2026, 10, 10, 9, 0, 0, 0).toISOString()
    const yesterday = new Date(2026, 10, 9, 9, 0, 0, 0).toISOString()
    const lastWeek = new Date(2026, 10, 3, 9, 0, 0, 0).toISOString()
    assert.equal(isDue({ kind: 'schedule', at: '09:00' }, { lastRunAt: yesterday, now: at }), true)
    assert.equal(isDue({ kind: 'schedule', at: '09:00' }, { lastRunAt: lastWeek, now: at }), true)
  })

  it('does not run a schedule it has already met today', () => {
    const now = new Date(2026, 10, 10, 9, 30, 0, 0).toISOString()
    const ran = new Date(2026, 10, 10, 9, 0, 1, 0).toISOString()
    assert.equal(isDue({ kind: 'schedule', at: '09:00' }, { lastRunAt: ran, now }), false)
  })

  it('runs a schedule later the same day if it has not met it', () => {
    const now = new Date(2026, 10, 10, 9, 30, 0, 0).toISOString()
    const ranYesterday = new Date(2026, 10, 9, 9, 0, 1, 0).toISOString()
    assert.equal(isDue({ kind: 'schedule', at: '09:00' }, { lastRunAt: ranYesterday, now }), true)
  })

  it('takes the schedule from the local wall clock, so 09:00 is 09:00 where the user is', () => {
    const localNine = new Date(2026, 10, 10, 9, 0, 0, 0)
    assert.equal(lastOccurrence('09:00', localNine.toISOString()), localNine.getTime())
  })

  it('never makes an event or a request routine due on its own', () => {
    assert.equal(isDue({ kind: 'event', types: ['work.ready'] }, { now: '2026-11-10T09:00:00.000Z' }), false)
    assert.equal(isDue({ kind: 'request' }, { now: '2026-11-10T09:00:00.000Z' }), false)
  })
})
