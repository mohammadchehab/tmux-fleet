/**
 * What Jira's REST API says about an issue, and what the contract's shapes call
 * it (architecture §3). Every field is read defensively — a payload from a
 * newer Jira, or from a proxy that injected an error page, is an
 * `external_failed` rather than a Work proposed with `undefined` for a title —
 * for the reason `@fleet/integrations-trackers-backlog` gives: an adapter that
 * guesses is worse than one that stops.
 *
 * Two conversions are not obvious and live in one place:
 *
 * - **`fields.updated` is not a `Timestamp` as printed.** Jira writes
 *   `2024-05-06T07:08:09.000+0000`; the fleet's timestamps are ISO 8601 UTC with
 *   a `Z`, and `timestamp()` would refuse the offset spelling. It is parsed and
 *   re-rendered, and an unparseable one falls back to the moment of the read.
 * - **`fields.description` is ADF.** See `adf.ts`; the body a Work carries is
 *   text.
 */

import { fleetError } from '@fleet/foundation-core'
import type { ExternalItem } from '@fleet/foundation-contracts'
import { adfToText } from './adf.ts'

/** The `system` every item from this adapter carries; it is also the profile's `system: jira`. */
export const JIRA_SYSTEM = 'jira'

/** The fields a `pull` and a `get` ask for: exactly what an `ExternalItem` is made of. */
export const JIRA_FIELDS = ['summary', 'status', 'description', 'updated'] as const

export interface ObserveOptions {
  /** The site, e.g. `https://acme.atlassian.net`; an issue's `url` is `<base>/browse/<KEY>`. */
  readonly baseUrl: string
  /** The clock, for an item whose `updated` cannot be parsed. */
  readonly now: () => string
}

const asObject = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fleetError('external_failed', `jira ${what} is not an object`, { details: { what } })
  }
  return value as Record<string, unknown>
}

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** `<base>/browse/<KEY>`: the page a person opens. */
export const browseUrl = (baseUrl: string, key: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`

/**
 * Jira's `+0000` offset spelling as the fleet's `Z`, through the instant rather
 * than by rewriting the string: `Date.parse` accepts the offset, and only a
 * value it cannot place falls back to the read.
 */
export const timestampOf = (raw: unknown, now: () => string): string => {
  const text = stringOrUndefined(raw)
  if (text === undefined) return now()
  const millis = Date.parse(text)
  return Number.isNaN(millis) ? now() : new Date(millis).toISOString()
}

/** `fields.status` is an object whose `name` is the column; a status id means nothing to a person. */
const statusOf = (fields: Record<string, unknown>): string => {
  const status = asObject(fields['status'], 'issue status')
  const name = stringOrUndefined(status['name'])
  if (name === undefined) {
    throw fleetError('external_failed', 'jira issue status has no name', { details: { hasId: status['id'] !== undefined } })
  }
  return name
}

/**
 * One issue as the contract's item. `pull` and `get` map through this one
 * function, because a search result and a fetched issue carry the same fields
 * when the same `fields` are asked for.
 */
export const itemFromIssue = (raw: unknown, options: ObserveOptions): ExternalItem => {
  const issue = asObject(raw, 'issue')
  const key = stringOrUndefined(issue['key'])
  const fields = asObject(issue['fields'], 'issue fields')
  const title = stringOrUndefined(fields['summary'])
  if (key === undefined || title === undefined) {
    throw fleetError('external_failed', 'jira issue came back without a key or a summary', {
      details: { hasKey: key !== undefined, hasTitle: title !== undefined },
    })
  }
  const body = adfToText(fields['description'])
  return {
    system: JIRA_SYSTEM,
    key,
    title,
    ...(body === undefined ? {} : { body }),
    status: statusOf(fields),
    url: browseUrl(options.baseUrl, key),
    updatedAt: timestampOf(fields['updated'], options.now),
  }
}

/** A search page's `issues`. An empty result is an empty list, not an error. */
export const issuesFrom = (raw: unknown, what: string): readonly unknown[] => {
  const page = asObject(raw, what)
  const issues = page['issues']
  if (!Array.isArray(issues)) {
    throw fleetError('external_failed', `jira ${what} printed no \`issues\` array`, { details: { what } })
  }
  return issues
}

/** A search page's `nextPageToken`, when the enhanced endpoint is in use. */
export const nextTokenFrom = (raw: unknown): string | undefined =>
  stringOrUndefined(asObject(raw, 'search page')['nextPageToken'])

/** Whether the enhanced endpoint said this was the last page. */
export const isLastPage = (raw: unknown): boolean => asObject(raw, 'search page')['isLast'] === true

/** One entry of `GET /issue/{key}/transitions`, as a `transition` call needs it. */
export interface JiraTransition {
  readonly id: string
  readonly name: string
  /** The status the transition lands in — the name a profile's `statuses` map is matched against. */
  readonly to: string | undefined
}

/**
 * An issue's available transitions. A profile maps a `WorkState` to a *status*,
 * so the match is against where a transition lands (`to.name`), not against the
 * transition's own name: a workflow may call the step "Start work" and the
 * column "In Progress", and a profile names the column.
 */
export const transitionsFrom = (raw: unknown): readonly JiraTransition[] => {
  const page = asObject(raw, 'transitions')
  const transitions = page['transitions']
  if (!Array.isArray(transitions)) {
    throw fleetError('external_failed', 'jira transitions printed no `transitions` array')
  }
  return transitions.flatMap((entry) => {
    const transition = asObject(entry, 'transition')
    const id = stringOrUndefined(transition['id'])
    const name = stringOrUndefined(transition['name'])
    if (id === undefined) return []
    const to = typeof transition['to'] === 'object' && transition['to'] !== null
      ? stringOrUndefined((transition['to'] as Record<string, unknown>)['name'])
      : undefined
    return [{ id, name: name ?? id, to }]
  })
}

/** The names a `transition` could not use, for the error that says so. */
export const transitionTargets = (transitions: readonly JiraTransition[]): string =>
  transitions.map((transition) => transition.to ?? transition.name).join(', ') || 'none'

/** A search page's `total`, which the classic endpoint reports and the enhanced one does not. */
export const totalFrom = (raw: unknown): number | undefined => {
  const total = asObject(raw, 'search page')['total']
  return typeof total === 'number' && Number.isFinite(total) ? total : undefined
}
