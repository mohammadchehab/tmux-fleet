/**
 * The `Tracker` port over Jira's REST API v3 (architecture §3). The mapping
 * lives in `observe.ts`, the transport in `client.ts`, so this file is only the
 * sequence: which endpoint, in which order, and what an answer means.
 *
 * Four behaviours the sync depends on and would be wrong without:
 *
 * - **`pull` takes JQL and pages honestly.** Cloud's enhanced endpoint pages
 *   with an opaque `nextPageToken` and reports `isLast`; Server / Data Center's
 *   classic endpoint pages with `startAt` against `total`. Both are followed
 *   until they stop, and a token that repeats — the documented way the enhanced
 *   endpoint can loop — ends the pull instead of hanging the routine.
 * - **`get` distinguishes "no such issue" from "the call failed".** A 404 is
 *   `undefined`; anything else throws, so a site that is down never reads as a
 *   board whose cards were deleted.
 * - **`transition` speaks `WorkState`.** The tracker's own vocabulary arrives as
 *   the profile's `statuses` map — the one place the two meet. A state the
 *   profile does not map sends nothing at all, because inventing a column would
 *   rewrite a board the fleet was never told about.
 * - **`link` is idempotent on purpose.** `tracker-sync` may see the same
 *   `work.review_requested` twice (a re-run, a resumed session), and Jira
 *   updates a remote link whose `globalId` it already has instead of creating a
 *   second one — so the PR URL is the `globalId`.
 */

import { fleetError, systemClock, type Clock } from '@fleet/foundation-core'
import type { ExternalItem, Tracker, WorkState } from '@fleet/foundation-contracts'
import { checkAuth, type JiraAuth } from './auth.ts'
import { createJiraClient, type FetchLike, type JiraClient, type JiraRequest } from './client.ts'
import {
  browseUrl,
  isLastPage,
  issuesFrom,
  JIRA_FIELDS,
  itemFromIssue,
  nextTokenFrom,
  totalFrom,
  transitionTargets,
  transitionsFrom,
  type ObserveOptions,
} from './observe.ts'

/**
 * Which search API the site serves. Cloud moved JQL to `/search/jql` and
 * deprecated `startAt`; Server / Data Center kept the classic endpoint. The
 * auth mode is the usual tell — an API token belongs to Cloud, a PAT to a
 * Server install — so this defaults to that and lets a profile override it for
 * the release where the two disagree.
 */
export const jiraSearchFlavors = ['enhanced', 'classic'] as const
export type JiraSearchFlavor = (typeof jiraSearchFlavors)[number]

const ENDPOINTS: Readonly<Record<JiraSearchFlavor, string>> = {
  enhanced: '/rest/api/3/search/jql',
  classic: '/rest/api/3/search',
}

/** The page size a pull asks for; Jira's own default is 50 and its ceiling is higher with few fields. */
const DEFAULT_PAGE_SIZE = 100

/** No board has this many pages of actionable cards; a pull that reaches it is looping, not reading. */
const DEFAULT_MAX_PAGES = 50

const issuePath = (key: string, suffix = ''): string =>
  `/rest/api/3/issue/${encodeURIComponent(key)}${suffix}`

export interface JiraTrackerOptions {
  /** The site, e.g. `https://acme.atlassian.net`. Credentials are never in here. */
  readonly baseUrl: string
  readonly auth: JiraAuth
  /** `WorkState` → the board's own status. A state the profile omits is left alone. */
  readonly statuses?: Partial<Record<WorkState, string>>
  /** Defaults to `globalThis.fetch`. A test supplies a fake; no login or live URL is needed to build this. */
  readonly fetch?: FetchLike
  /** Defaults to derived from `auth.kind`; see `jiraSearchFlavors`. */
  readonly search?: JiraSearchFlavor
  /** Defaults to 100. */
  readonly pageSize?: number
  /** Defaults to 50: the bound that turns an endless token chain into an error. */
  readonly maxPages?: number
  readonly clock?: Clock
}

/**
 * The port over the API. `options.baseUrl` is the site; everything else is the
 * profile's opinion of the board.
 */
export const createJiraTracker = (options: JiraTrackerOptions): Tracker => {
  const auth = checkAuth(options.auth)
  const client: JiraClient = createJiraClient({
    baseUrl: options.baseUrl,
    auth,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const clock = options.clock ?? systemClock
  const statuses = options.statuses ?? {}
  const observe: ObserveOptions = { baseUrl: options.baseUrl, now: () => clock.now() }
  const flavor: JiraSearchFlavor = options.search ?? (auth.kind === 'cloud' ? 'enhanced' : 'classic')
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES

  /** One page of a search, either flavor; `nextPageToken` is only meaningful to the enhanced one. */
  const searchPage = (query: string, cursor: { readonly token?: string; readonly startAt: number }): Promise<unknown> => {
    const paging: Readonly<Record<string, string | number | undefined>> =
      flavor === 'enhanced' ? { nextPageToken: cursor.token } : { startAt: cursor.startAt }
    const request: JiraRequest = {
      method: 'GET',
      path: ENDPOINTS[flavor],
      query: { jql: query, fields: JIRA_FIELDS.join(','), maxResults: pageSize, ...paging },
    }
    return client.json(request)
  }

  return {
    /** The profile's query is JQL, passed through untouched: Jira's dialect is the board's, not ours. */
    async pull(query) {
      const items: ExternalItem[] = []
      const seen = new Set<string>()
      let token: string | undefined
      let startAt = 0
      for (let page = 0; page < maxPages; page += 1) {
        const body = await searchPage(query, { ...(token === undefined ? {} : { token }), startAt })
        const issues = issuesFrom(body, 'search')
        for (const issue of issues) items.push(itemFromIssue(issue, observe))
        if (issues.length === 0) return items

        if (flavor === 'enhanced') {
          const next = nextTokenFrom(body)
          // `isLast` and a missing token both mean done; a token already seen means the
          // endpoint is looping, and following it would never return.
          if (isLastPage(body) || next === undefined || seen.has(next)) return items
          seen.add(next)
          token = next
          continue
        }

        startAt += issues.length
        const total = totalFrom(body)
        if (total === undefined || startAt >= total) return items
      }
      throw fleetError('external_failed', `jira search did not finish after ${maxPages} pages`, {
        details: { jql: query, maxPages, flavor },
      })
    },

    async get(key) {
      const answer = await client.optional({
        method: 'GET',
        path: issuePath(key),
        query: { fields: JIRA_FIELDS.join(',') },
      })
      return answer === undefined ? undefined : itemFromIssue(answer.body, observe)
    },

    async transition(key, to) {
      const status = statuses[to]
      // Not mapped: the profile has no opinion, and a board that was never told
      // how this fleet's states line up must not be edited anyway.
      if (status === undefined) return
      const transitions = transitionsFrom(
        await client.json({ method: 'GET', path: issuePath(key, '/transitions') }),
      )
      const transition = transitions.find((candidate) => candidate.to === status)
      if (transition === undefined) {
        throw fleetError('external_failed', `jira issue ${key} cannot move to "${status}": it offers ${transitionTargets(transitions)}`, {
          details: { key, status, offered: transitions.map((candidate) => candidate.to ?? candidate.name) },
        })
      }
      await client.json({
        method: 'POST',
        path: issuePath(key, '/transitions'),
        body: { transition: { id: transition.id } },
      })
    },

    async link(key, prUrl) {
      // `globalId` is the PR URL: Jira updates a remote link it already holds rather
      // than making a second, which is what makes a second `work.review_requested` safe.
      const answer = await client.optional({
        method: 'POST',
        path: issuePath(key, '/remotelink'),
        body: {
          globalId: prUrl,
          relationship: 'is implemented by',
          object: { url: prUrl, title: 'Pull request' },
        },
      })
      if (answer === undefined) {
        throw fleetError('external_failed', `cannot link ${prUrl}: jira has no issue ${key}`, {
          details: { key, url: browseUrl(options.baseUrl, key) },
        })
      }
    },
  }
}
