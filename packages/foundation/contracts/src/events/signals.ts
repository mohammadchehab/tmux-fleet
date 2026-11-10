/**
 * The signals other loops read: notifications (§6.1), the standup (§6), the
 * findings pipeline (§6.2) and per-turn token usage (§6.2, §8). The PM appends
 * the events; it does not know a notifier exists.
 */

import { count, event, number, object, oneOf, optional, positiveInt, string, text } from '@fleet/foundation-core'
import {
  decisionId,
  findingId,
  notificationKey,
  peerId,
  sessionId,
  sha,
  workId,
} from '@fleet/foundation-core'
import { repo } from '@fleet/foundation-core'
import { filePath, line, lineNumber, pullRequestRef, severity } from '../shapes.ts'

// -------------------------------------------------------------- notifications

/** The three classes that notify; everything else is a projection the user reads (§6.1). */
export const notificationClasses = ['decision', 'failure', 'standup'] as const
export type NotificationClass = (typeof notificationClasses)[number]

/** A notification was delivered through a channel (`macos` first). */
export const notifySent = event(
  'notify.sent',
  object({
    key: notificationKey(),
    class: oneOf(notificationClasses),
    channel: string({ minLength: 1, maxLength: 40 }),
    title: line(),
    body: text(2000),
  }),
)

/** Delivery failed. The decision stays visible in `fleet ls` and `fleet decide` (§6.1). */
export const notifyFailed = event(
  'notify.failed',
  object({
    key: notificationKey(),
    class: oneOf(notificationClasses),
    channel: string({ minLength: 1, maxLength: 40 }),
    error: text(2000),
  }),
)

/** The key resolved: `Notifier.withdraw` clears a banner still on screen (§6.1). */
export const notifyWithdrawn = event('notify.withdrawn', object({ key: notificationKey() }))

/** The daily standup, rendered from projections with no model call (§5.2, §6). */
export const standupRendered = event(
  'standup.rendered',
  object({
    date: string({ pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    text: text(100_000),
    peers: count(),
    openDecisions: count(),
  }),
)

// -------------------------------------------------------------------- findings

/** A scanner finished a run over one SHA; a skip is recorded, never silent (§6.2). */
export const scanSkipped = event(
  'scan.skipped',
  object({
    repo: repo(),
    sha: sha(),
    tool: string({ minLength: 1, maxLength: 60 }),
    reason: string({ minLength: 1, maxLength: 500 }),
  }),
)

/**
 * A typed finding. Its `fingerprint` is `hash(ruleId + path + normalized
 * snippet)`, so a re-run that sees the same rule at the same place appends
 * `finding.seen` rather than a duplicate (§6.2).
 */
export const findingRaised = event(
  'finding.raised',
  object({
    findingId: findingId(),
    fingerprint: string({ minLength: 8, maxLength: 200 }),
    tool: string({ minLength: 1, maxLength: 60 }),
    ruleId: string({ minLength: 1, maxLength: 200 }),
    severity: severity(),
    path: filePath(),
    line: optional(lineNumber()),
    message: text(2000),
    sha: sha(),
    pr: optional(pullRequestRef()),
  }),
)

/** The same fingerprint seen again; the projection bumps its count, not its identity. */
export const findingSeen = event(
  'finding.seen',
  object({ findingId: findingId(), fingerprint: string({ minLength: 8, maxLength: 200 }), sha: sha() }),
)

/** The security-architect verified a finding, reading only the cited code (§6.2). */
export const findingVerdicts = ['confirmed', 'dismissed'] as const
export type FindingVerdict = (typeof findingVerdicts)[number]

export const findingVerdicted = event(
  'finding.verdict_given',
  object({
    findingId: findingId(),
    verdict: oneOf(findingVerdicts),
    /** Required: a dismissal without a reason is not remembered by fingerprint. */
    reason: text(1000),
    by: peerId(),
  }),
)

/** A confirmed finding became work, or a decision when it is critical (§6.2). */
export const findingRouted = event(
  'finding.routed',
  object({
    findingId: findingId(),
    workId: optional(workId()),
    decisionId: optional(decisionId()),
  }),
)

// ----------------------------------------------------------------- turn usage

/** Per-turn usage, from the provider's `usage()`, feeding the `token-report` (§6.2). */
export const turnUsage = event(
  'turn.usage_recorded',
  object({
    peerId: peerId(),
    sessionId: optional(sessionId()),
    workId: optional(workId()),
    contextTokens: count(),
    contextLimit: positiveInt(),
    inputTokens: count(),
    outputTokens: count(),
    cachedTokens: count(),
    /** How the turn spent its exploration: the guard is measured, not assumed (§6.2). */
    toolCalls: object({
      grep: count(),
      glob: count(),
      read: count(),
      codegraph: count(),
    }),
    costUsd: optional(number({ min: 0 })),
  }),
)
