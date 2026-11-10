/**
 * Delivery: turn a plan into the events that close the loop (§6.1). One
 * `notify.sent` per banner that reached the screen, one `notify.failed` per
 * banner that did not, one `notify.withdrawn` per banner taken back.
 *
 * The batch is appended once, after every banner has been attempted. A run that
 * dies halfway leaves nothing behind, and the next tick plans from the same
 * rows — retrying is the absence of a `notify.sent`, not a separate mechanism.
 *
 * A channel that throws is a failure, not an exception: §6.1 says delivery
 * failure is an event, and a tick that threw would lose the banners after it.
 */

import { systemClock, type Clock, type NotificationKey, type Seq } from '@fleet/foundation-core'
import type { AppendEvent, EventSink } from '@fleet/foundation-contracts'
import type { Notifier } from './notifier.ts'
import type { NotificationPlan, PlannedSend } from './plan.ts'

export interface DeliverDeps {
  readonly notifier: Notifier
  readonly store: EventSink
  /** Injected so a test pins the timestamps the events carry (§5.4). */
  readonly clock?: Clock
}

export interface DeliveryReport {
  readonly sent: number
  readonly failed: number
  readonly withdrawn: number
  /** The seqs the store assigned, in the order the batch was given. */
  readonly events: readonly Seq[]
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const deliverNotifications = async (
  plan: NotificationPlan,
  deps: DeliverDeps,
): Promise<DeliveryReport> => {
  const ts = (deps.clock ?? systemClock).now()
  const batch: AppendEvent[] = []
  let sent = 0
  let failed = 0
  let withdrawn = 0

  const failedEvent = (send: Pick<PlannedSend, 'key' | 'class'>, error: string): AppendEvent => ({
    ts,
    type: 'notify.failed',
    // The key is the subject: a notification is about the thing it names (§3).
    subject: send.key,
    actor: 'scheduler',
    data: { key: send.key, class: send.class, channel: deps.notifier.id, error: error.slice(0, 2000) },
  })

  for (const item of plan.send) {
    let delivered = false
    try {
      const result = await deps.notifier.notify({
        key: item.key,
        class: item.class,
        title: item.title,
        body: item.body,
        ...(item.action === undefined ? {} : { action: item.action }),
      })
      delivered = result.delivered
      if (delivered) {
        sent += 1
        batch.push({
          ts,
          type: 'notify.sent',
          subject: item.key,
          actor: 'scheduler',
          data: { key: item.key, class: item.class, channel: deps.notifier.id, title: item.title, body: item.body },
        })
      } else {
        failed += 1
        batch.push(failedEvent(item, `${deps.notifier.id} declined to show it`))
      }
    } catch (error) {
      failed += 1
      batch.push(failedEvent(item, errorText(error)))
    }
  }

  for (const item of plan.withdraw) {
    try {
      await deps.notifier.withdraw?.(item.key)
    } catch (error) {
      // A banner that would not clear is still a resolved key; record the failure and let the next run retry the
      // withdraw, rather than pretending the screen is clean.
      failed += 1
      batch.push(failedEvent(item, errorText(error)))
      continue
    }
    withdrawn += 1
    batch.push({ ts, type: 'notify.withdrawn', subject: item.key, actor: 'scheduler', data: { key: item.key } })
  }

  if (batch.length === 0) return { sent, failed, withdrawn, events: [] }
  const events = await deps.store.append(batch)
  return { sent, failed, withdrawn, events }
}

/** The keys a plan would touch; handy for a log line in the `notify` routine (§6). */
export const plannedKeys = (plan: NotificationPlan): readonly NotificationKey[] => [
  ...plan.send.map((item) => item.key),
  ...plan.withdraw.map((item) => item.key),
]
