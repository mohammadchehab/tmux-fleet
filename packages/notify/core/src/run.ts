/**
 * One `notify` tick (§6): read the rows, plan, deliver. This is the body the
 * `notify` routine calls, kept here rather than in `orchestration/routines` so
 * the rules and the channel are one package's business and the routine only
 * wires triggers (§1.1).
 *
 * Everything it touches is injected — the read model, the sink, the notifier,
 * the clock — so a test is fakes away and a replay of the routine's events
 * produces the same banners (§5.4).
 */

import { systemClock, type Clock } from '@fleet/foundation-core'
import type { Decision, EventSink, Notification, ReadModel } from '@fleet/foundation-contracts'
import { deliverNotifications, type DeliveryReport } from './deliver.ts'
import type { Notifier } from './notifier.ts'
import { planNotifications, type NotificationPlan, type StandupNotice } from './plan.ts'
import { defaultNotifyPolicy, type NotifyPolicy } from './policy.ts'

/** Only the two projections the rules read; the daemon passes its whole read model (§3). */
export type NotifyReadModel = Pick<ReadModel, 'notifications' | 'decisions'>

export interface NotifyRunDeps {
  readonly read: NotifyReadModel
  readonly store: EventSink
  readonly notifier: Notifier
  readonly policy?: NotifyPolicy
  readonly clock?: Clock
  /**
   * The standups rendered since the last tick. A `notify` tick woken by
   * `standup.rendered` passes that event's `{date, text}`; the projection row
   * has no text of its own, so without it the banner says only that one is ready.
   */
  readonly standups?: readonly StandupNotice[]
}

export interface NotifyRunReport extends DeliveryReport {
  readonly plan: NotificationPlan
}

export const runNotify = async (deps: NotifyRunDeps): Promise<NotifyRunReport> => {
  const clock = deps.clock ?? systemClock
  // Every row, not only the pending ones: the withdraws come from the resolved rows (§6.1).
  const [notifications, open] = await Promise.all([
    deps.read.notifications.all() as Promise<readonly Notification[]>,
    deps.read.decisions.open() as Promise<readonly Decision[]>,
  ])
  const plan = planNotifications({
    notifications,
    decisions: open,
    ...(deps.standups === undefined ? {} : { standups: deps.standups }),
    now: clock.now(),
    policy: deps.policy ?? defaultNotifyPolicy,
  })
  const delivery = await deliverNotifications(plan, {
    notifier: deps.notifier,
    store: deps.store,
    clock,
  })
  return { ...delivery, plan }
}
