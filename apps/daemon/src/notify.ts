/**
 * The `notify` routine's body, and the channel it rings (§6, §6.1).
 *
 * `@fleet/notify-core` holds §6.1's rules and the `Notifier` port; it is a leaf
 * that knows nothing about routines. `@fleet/orchestration/routines` holds the
 * bodies that are a PM tick. The two are married here, in the daemon, because
 * this file is the only place allowed to know both sides (§1.1): the scheduler
 * is handed a factory that closes over the store sink and the channel, and the
 * body it builds runs one `notify` tick.
 *
 * That is also why `RoutineBodyDeps` does not grow (§6): a routine stays
 * ignorant of notifications, and notify stays a leaf. The factory ignores the
 * PM and the executor it is offered — a notification decides nothing and
 * performs nothing the PM planned — and uses only the projections it was handed.
 */

import type { EventSink, FleetEvent } from '@fleet/foundation-contracts'
import { runNotify, type Notifier, type NotifyReadModel, type StandupNotice } from '@fleet/notify-core'
import { createMacNotifier } from '@fleet/notify-macos'
import { shortHash } from '@fleet/orchestration-pm'
import type { RoutineContext, RoutineFactory, RoutineOutcome } from '@fleet/orchestration-routines'
import type { Profile } from './profile.ts'

/** What the body needs that the scheduler does not hand a routine: the sink and the channel (§1.1). */
export interface NotifyWiring {
  readonly store: EventSink
  readonly notifier: Notifier
}

/**
 * The `notify` entry of the scheduler's factory map. It takes the projections
 * the scheduler passes every body and closes over everything else.
 */
export const createNotifyFactory = (wiring: NotifyWiring): RoutineFactory => (deps) => ({
  kind: 'notify',
  run: (context) => notified({ read: deps.read, ...wiring }, context),
})

/**
 * One tick: read the ledger and the open decisions, let §6.1's rules decide,
 * deliver, and append what happened. A standup that woke this run carries its
 * own text in the event — the projection row has none — so it is read from
 * there rather than re-rendered (§6.1).
 */
export const notified = async (
  deps: NotifyWiring & { readonly read: NotifyReadModel },
  context: RoutineContext,
): Promise<RoutineOutcome> => {
  const standups = standupsOf(context.event)
  const report = await runNotify({
    read: deps.read,
    store: deps.store,
    notifier: deps.notifier,
    clock: context.clock,
    ...(standups === undefined ? {} : { standups }),
  })

  return {
    // Every banner and every withdraw is one action; the ones that failed are
    // also the count the fleet could not carry out (§5.2, §6).
    actions: report.sent + report.withdrawn + report.failed,
    actionsFailed: report.failed,
    // The plan is a function of nothing but what the tick read, so it is what
    // §5.4's `inputsHash` hashes: the same ledger and the same instant plan the
    // same, and a run can be traced to the rows that produced it.
    inputsHash: shortHash({ plan: report.plan, standups: standups ?? [] }),
  }
}

/** The standup a `standup.rendered` event carries; any other trigger contributes none (§6.1). */
const standupsOf = (event: FleetEvent | undefined): readonly StandupNotice[] | undefined => {
  if (event === undefined || event.type !== 'standup.rendered') return undefined
  return [{ date: event.data.date, text: event.data.text }]
}

/**
 * The channel a profile asks for (§6.1). `none`, or a profile that says
 * nothing, means no `notify` routine is installed at all: the ledger still
 * records every notification, and nothing rings.
 *
 * `macos` on a host that is not a Mac is a misconfiguration, not a runtime
 * condition — the daemon says so once at start-up rather than appending a
 * `notify.failed` on every tick for the rest of its life.
 */
export const notifierFor = (
  profile: Profile,
  platform: NodeJS.Platform = process.platform,
  log: (line: string) => void = (line) => console.error(line),
): Notifier | undefined => {
  if (profile.notify?.channel !== 'macos') return undefined
  if (platform !== 'darwin') {
    log(`fleetd: notify.channel is "macos" but this host is ${platform}; notifications are off`)
    return undefined
  }
  return createMacNotifier()
}
