/**
 * The `Notifier` port (architecture §6.1). A channel knows how to put a banner
 * on the user's screen and how to take it back; it does not know why, or
 * whether it should. That question is `plan.ts`'s, and keeping the two apart is
 * what lets a phone or a Slack channel land beside `macos` without touching a
 * rule.
 *
 * §6.1 spells the interface as `notify(n: Notification)`. The row's state
 * fields (`pending`, `sent`, `occurrences`, …) are the planner's bookkeeping,
 * so a channel is handed the message instead: the same `{key, class, title,
 * body, action}` the design lists, and nothing it could act on twice.
 */

import type { NotificationKey } from '@fleet/foundation-core'
import type { NotificationClass } from '@fleet/foundation-contracts'

/** What a click on the banner runs; `{cmd: 'fleet decide <id>'}` for a decision (§6.1). */
export interface NotifierAction {
  readonly cmd: string
}

export interface NotifierMessage {
  readonly key: NotificationKey
  readonly class: NotificationClass
  /** One line: a pending notification is glanced at, not read (§6.1). */
  readonly title: string
  readonly body: string
  readonly action?: NotifierAction
}

export interface NotifyResult {
  /** A channel that could not deliver says so; the planner records `notify.failed`, never a throw (§6.1). */
  readonly delivered: boolean
}

export interface Notifier {
  /** The channel's name, recorded on every `notify.sent` (`macos`, later `phone`, `slack`). */
  readonly id: string

  notify(message: NotifierMessage): Promise<NotifyResult>

  /**
   * Clear a banner that is still on screen when its key resolves (§6.1). An
   * implementation that cannot do this (an `osascript` banner) omits it, and
   * the planner's `notify.withdrawn` is then a no-op rather than a lie.
   */
  withdraw?(key: NotificationKey): Promise<void>
}
