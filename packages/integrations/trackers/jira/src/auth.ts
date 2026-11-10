/**
 * The two ways a Jira install authenticates (architecture §3).
 *
 * Jira's deployments hand out two different kinds of credential, and a profile
 * says which one it holds:
 *
 * - **Cloud** — an Atlassian account's email plus an API token, sent as HTTP
 *   basic. Atlassian has no other way for a script to authenticate to Cloud:
 *   there is no password, and the token belongs to the account named by the
 *   email.
 * - **Server / Data Center** — a personal access token, sent as a bearer token.
 *   A PAT is issued in the instance's own UI and is already an identity, so
 *   there is no email half.
 *
 * The credential is only ever a request header. It never goes in a URL — a JQL
 * query is passed as a query parameter and would otherwise sit in every access
 * log and error message — and it never goes in an error's message or details,
 * because those are appended to the event log and read by people who should not
 * be handed a token.
 */

import { fleetError } from '@fleet/foundation-core'

export const jiraAuthKinds = ['cloud', 'pat'] as const
export type JiraAuthKind = (typeof jiraAuthKinds)[number]

/** Cloud: `email` names the account, `token` is the API token issued for it. */
export interface JiraCloudAuth {
  readonly kind: 'cloud'
  readonly email: string
  readonly token: string
}

/** Server / Data Center: one personal access token, no email half. */
export interface JiraPatAuth {
  readonly kind: 'pat'
  readonly token: string
}

export type JiraAuth = JiraCloudAuth | JiraPatAuth

/**
 * Base64 over the email and the token, UTF-8 encoded. `Buffer` rather than
 * `btoa`: an email may be non-ASCII, and `btoa` throws on anything above U+00FF
 * instead of encoding it.
 */
const basic = (email: string, token: string): string =>
  `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`

/** The `authorization` header, and the only place the credential is written down. */
export const authorizationHeader = (auth: JiraAuth): string =>
  auth.kind === 'cloud' ? basic(auth.email, auth.token) : `Bearer ${auth.token}`

/**
 * Refuse an empty credential when the adapter is built, not on every request: a
 * profile that lost its token would otherwise look like a board that refuses to
 * answer, and the sync would report `external_failed` forever instead of saying
 * the configuration is wrong.
 */
export const checkAuth = (auth: JiraAuth): JiraAuth => {
  const missing = (what: string): never => {
    throw fleetError('invalid_input', `jira ${auth.kind} auth is missing its ${what}`, {
      details: { kind: auth.kind, field: what },
    })
  }
  if (auth.kind === 'cloud' && auth.email.trim() === '') missing('email')
  if (auth.token.trim() === '') missing('token')
  return auth
}
