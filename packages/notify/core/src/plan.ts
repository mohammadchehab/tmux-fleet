/**
 * §6.1's notification rules, as a pure function of the notification rows, the
 * open decisions, the standups the caller saw rendered, and the clock. No
 * channel, no store, no I/O: the same rows and the same `now` always produce the
 * same plan, which is what makes the `notify` routine's replay worth anything.
 *
 * The four rules the design names, and where each one is:
 *
 * 1. **Dedupe** — one notification per key. The rows are keyed, and a row
 *    yields at most one send, so a run cannot say the same thing twice.
 * 2. **Failure rate limit** — a failing key is sent once, then silent until it
 *    resolves or `failureWindowMinutes` passes, when it repeats with the
 *    occurrence count ("still failing, 4 events"). Never one banner per retry.
 * 3. **Still waiting** — an open decision gets at most one quiet reminder after
 *    `reminderAfterMinutes`, then none. `remindedAt` on the row is how the
 *    "at most one" is known; the store sets it on the second `notify.sent`.
 * 4. **Close** — a resolved key that was delivered is withdrawn, once. The
 *    store's `withdrawnAt` is what makes the second run a no-op.
 *
 * A pending row is retried on every run. A delivery failure is recorded as
 * `notify.failed` (§6.1) rather than hidden, so a broken channel shows up as a
 * run of failures and fixes itself when the channel does.
 */

import type { NotificationKey, Timestamp } from '@fleet/foundation-core'
import type { Decision, Notification, NotificationClass } from '@fleet/foundation-contracts'
import { defaultNotifyPolicy, type NotifyPolicy } from './policy.ts'
import type { NotifierAction } from './notifier.ts'

/** A standup the caller saw rendered; the projection row carries no text, the event does (§6, §6.1). */
export interface StandupNotice {
  readonly date: string
  readonly text: string
}

/** Why a banner goes out now: the first time, §6.1's failure repeat, or the one reminder. */
export type SendReason = 'first' | 'repeat' | 'reminder'

export interface PlannedSend {
  readonly key: NotificationKey
  readonly class: NotificationClass
  readonly title: string
  readonly body: string
  readonly action?: NotifierAction
  readonly reason: SendReason
  /** The row's count, so a repeat can say "still failing, N events" (§6.1). */
  readonly occurrences: number
}

/** A banner to clear. It carries its class so a `notify.failed` on the withdraw can still say what key it was. */
export interface PlannedWithdraw {
  readonly key: NotificationKey
  readonly class: NotificationClass
}

export interface NotificationPlan {
  readonly send: readonly PlannedSend[]
  readonly withdraw: readonly PlannedWithdraw[]
}

export interface PlanInput {
  /** Every row, resolved ones included: those are what the withdraws come from. */
  readonly notifications: readonly Notification[]
  /** The open decisions, for the question, the options and the reminder's "still". */
  readonly decisions?: readonly Decision[]
  /** Standups rendered in this run's window; a standup row without one falls back to its own text. */
  readonly standups?: readonly StandupNotice[]
  readonly now: Timestamp
  readonly policy?: NotifyPolicy
}

/** Banners are glanced at: a title is one line, and a long body is cut, not wrapped (§6.1). */
const TITLE_LIMIT = 120
const BODY_LIMIT = 2000

const oneLine = (value: string): string => {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= TITLE_LIMIT ? flat : `${flat.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
}

const cut = (value: string): string => (value.length <= BODY_LIMIT ? value : `${value.slice(0, BODY_LIMIT - 1).trimEnd()}…`)

/** `decision:<id>` → `<id>`; the id the inbox and `fleet decide` use (§6.1). */
const afterPrefix = (key: string, prefix: string): string =>
  key.startsWith(`${prefix}:`) ? key.slice(prefix.length + 1) : key

/**
 * `failure:<subject>:<kind>`. The subject may itself contain `:` (a PR key is
 * `repo#number`, but a peer id or a work id need not be colon-free), so the kind
 * is the last segment and everything between is the subject.
 */
const failureParts = (key: string): { readonly subject: string; readonly kind: string } => {
  const parts = afterPrefix(key, 'failure').split(':')
  const kind = parts.length > 1 ? (parts.at(-1) ?? '') : 'failure'
  return { subject: parts.length > 1 ? parts.slice(0, -1).join(':') : parts[0] ?? key, kind }
}

const decisionAction = (id: string): NotifierAction => ({ cmd: `fleet decide ${id}` })

const decisionMessage = (
  id: string,
  decision: Decision | undefined,
  reminder: boolean,
): { readonly title: string; readonly body: string; readonly action: NotifierAction } => {
  const action = decisionAction(id)
  if (decision === undefined) {
    // The key exists but the row does not: still actionable, so the banner is honest about what it knows.
    return { title: reminder ? 'Still waiting on a decision' : 'Decision needed', body: `Open decision ${id}. Run:\n${action.cmd}`, action }
  }
  const options = decision.options.length > 0 ? `\nOptions: ${decision.options.join(' · ')}` : ''
  return {
    title: oneLine(reminder ? `Still waiting: ${decision.question}` : `Decision needed: ${decision.question}`),
    body: cut(`${decision.question}${options}\n\n${action.cmd}`),
    action,
  }
}

const failureMessage = (
  key: string,
  occurrences: number,
  repeat: boolean,
): { readonly title: string; readonly body: string } => {
  const { subject, kind } = failureParts(key)
  return repeat
    ? {
        title: oneLine(`Still failing: ${kind}`),
        body: cut(`${subject} — ${occurrences} events since the last notice.`),
      }
    : { title: oneLine(`Failure: ${kind}`), body: cut(`${subject} — ${kind}.`) }
}

const standupMessage = (
  row: Notification,
  notice: StandupNotice | undefined,
): { readonly title: string; readonly body: string } => {
  const date = afterPrefix(row.key, 'standup')
  const text = notice?.date === date ? notice.text : row.body
  return {
    title: oneLine(`Standup ${date}`),
    body: cut(text ?? 'The daily standup is ready. Run: fleet standup'),
  }
}

/**
 * Turn the rows into this run's banners. Pure: no clock read of its own, no
 * channel, no store. The caller appends `notify.sent` for each send and
 * `notify.withdrawn` for each withdraw, which is what closes the loop.
 */
export const planNotifications = (input: PlanInput): NotificationPlan => {
  const policy = input.policy ?? defaultNotifyPolicy
  const nowMillis = Date.parse(input.now)
  const decisions = new Map((input.decisions ?? []).map((decision) => [String(decision.decisionId), decision]))
  const standups = new Map((input.standups ?? []).map((notice) => [notice.date, notice]))
  const send: PlannedSend[] = []
  const withdraw: PlannedWithdraw[] = []

  for (const row of input.notifications) {
    // 4. Close: a key that resolved after it was delivered has a banner to clear — once.
    if (row.state === 'resolved') {
      if (row.sentAt !== undefined && row.withdrawnAt === undefined) withdraw.push({ key: row.key, class: row.class })
      continue
    }

    // A class the profile turned off notifies nobody (§6.1: routing is profile config).
    if (!policy.classes.includes(row.class)) continue

    const elapsed = row.sentAt === undefined ? Number.POSITIVE_INFINITY : (nowMillis - Date.parse(row.sentAt)) / 60_000

    if (row.state === 'pending') {
      // 1. Dedupe in the negative: never delivered, so this is the one and only first send.
      const message =
        row.class === 'decision'
          ? decisionMessage(afterPrefix(row.key, 'decision'), decisions.get(afterPrefix(row.key, 'decision')), false)
          : row.class === 'failure'
            ? failureMessage(row.key, row.occurrences, false)
            : standupMessage(row, standups.get(afterPrefix(row.key, 'standup')))
      send.push({ key: row.key, class: row.class, ...message, reason: 'first', occurrences: row.occurrences })
      continue
    }

    // 2. Failure rate limit: one banner per window, with the count appended.
    if (row.class === 'failure' && elapsed >= policy.failureWindowMinutes) {
      send.push({
        key: row.key,
        class: row.class,
        ...failureMessage(row.key, row.occurrences, true),
        reason: 'repeat',
        occurrences: row.occurrences,
      })
      continue
    }

    // 3. Still waiting: one quiet reminder, and only while the decision is open.
    if (row.class === 'decision' && row.remindedAt === undefined && elapsed >= policy.reminderAfterMinutes) {
      const id = afterPrefix(row.key, 'decision')
      const decision = decisions.get(id)
      if (decision !== undefined && decision.state !== 'open') continue
      send.push({ key: row.key, class: row.class, ...decisionMessage(id, decision, true), reason: 'reminder', occurrences: row.occurrences })
    }

    // A standup never repeats: the day's summary is read once (§6.1).
  }

  return { send, withdraw }
}
