/**
 * The notification knobs (§6.1), in one place so a profile can change them and
 * the planner never hard-codes a window. Every value here is a rule §6.1 names;
 * nothing else is tunable, because a channel that rings more often than the
 * design says is the failure mode this file exists to prevent.
 */

import { array, number, objectAs, oneOf, parse, type Schema } from '@fleet/foundation-core'
import { notificationClasses, type NotificationClass } from '@fleet/foundation-contracts'

export interface NotifyPolicy {
  /** Which classes reach the user. PR-ready, idle and routine news are not classes at all (§6.1). */
  readonly classes: readonly NotificationClass[]
  /** §6.1's failure window: a failing key is silent this long, then repeats with a count. */
  readonly failureWindowMinutes: number
  /** §6.1's "still waiting": at most one quiet reminder per open decision, after this long. */
  readonly reminderAfterMinutes: number
}

/** §6.1's numbers: a 6 h failure window, an 8 h reminder. */
export const defaultNotifyPolicy: NotifyPolicy = {
  classes: ['decision', 'failure', 'standup'],
  failureWindowMinutes: 6 * 60,
  reminderAfterMinutes: 8 * 60,
}

export const notifyPolicySchema = (): Schema<NotifyPolicy> =>
  objectAs<NotifyPolicy>()({
    classes: array(oneOf(notificationClasses)),
    // A week is the ceiling: past it a "rate limit" is a notification nobody sees again.
    failureWindowMinutes: number({ int: true, min: 1, max: 7 * 24 * 60 }),
    reminderAfterMinutes: number({ int: true, min: 1, max: 7 * 24 * 60 }),
  })

/**
 * The policy a profile gets. Overrides are parsed, so a typo in a profile fails
 * at startup instead of turning into a window of `NaN` minutes that silences
 * the fleet.
 */
export const notifyPolicy = (overrides: Partial<NotifyPolicy> = {}): NotifyPolicy =>
  parse(notifyPolicySchema(), { ...defaultNotifyPolicy, ...overrides })
