/**
 * The HTTP client every Jira call goes through (architecture §3).
 *
 * `fetch` is a dependency, not a global: a test injects one and is answered
 * without a network, and building this adapter needs no site, no login and no
 * URL that resolves. `globalThis.fetch` is the default, so the daemon needs no
 * wiring for the real thing.
 *
 * Three rules this file exists to keep in one place:
 *
 * - **The credential is a header and nothing else.** It is never appended to a
 *   URL (a JQL query is a query parameter, so anything in the URL ends up in
 *   access logs and in whatever a failing proxy echoes back).
 * - **An error names the method and the path, never the token, and never the
 *   whole body.** `external_failed` messages are appended to the event log and
 *   read by people; a description or a token must not arrive there by accident.
 * - **A timeout is a `timeout`, a network failure is `external_failed`.** A
 *   socket that never answers must not stall a routine for the daemon's life.
 */

import { fleetError } from '@fleet/foundation-core'
import { authorizationHeader, type JiraAuth } from './auth.ts'

/** The one thing this adapter takes from the platform, so a test needs no network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init)

/** Enough of a failed body to recognise it; a Jira error is a short JSON object. */
const SNIPPET = 200

export interface JiraRequest {
  readonly method: 'GET' | 'POST'
  /** The API path from `/rest/api/3`, with every segment already encoded. */
  readonly path: string
  /** Query parameters. An `undefined` value is left out rather than sent as `undefined`. */
  readonly query?: Readonly<Record<string, string | number | undefined>>
  /** Sent as JSON; omitted entirely for a GET. */
  readonly body?: unknown
}

/** A response as the caller sees it: the status, and the body read the way that call needs it. */
export interface JiraCall {
  readonly status: number
  readonly ok: boolean
  read(): Promise<string>
}

export interface JiraClientOptions {
  /** The site, e.g. `https://acme.atlassian.net`. A trailing slash is fine. */
  readonly baseUrl: string
  readonly auth: JiraAuth
  /** Defaults to `globalThis.fetch`. A test supplies a fake and reads the request it got. */
  readonly fetch?: FetchLike
  /** Defaults to 20s: a search that hangs is a failed routine, not a slow one. */
  readonly timeoutMillis?: number
}

export interface JiraClient {
  /** The raw answer, for a call that reads the status itself — `get`'s 404 means "no such issue". */
  send(request: JiraRequest): Promise<JiraCall>
  /** The parsed body of a call that must succeed; anything but a 2xx throws `external_failed`. */
  json(request: JiraRequest): Promise<unknown>
  /**
   * A call for which 404 is an answer rather than a failure — "there is no such
   * issue" is what `get` reports and what `link` refuses. Any other non-2xx
   * still throws, so a broken site never reads as a deleted issue.
   */
  optional(request: JiraRequest): Promise<{ readonly body: unknown } | undefined>
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '')

const urlOf = (baseUrl: string, request: JiraRequest): string => {
  const url = `${trimSlash(baseUrl)}${request.path}`
  const pairs = Object.entries(request.query ?? {}).flatMap(([key, value]) =>
    value === undefined ? [] : [`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`],
  )
  return pairs.length === 0 ? url : `${url}?${pairs.join('&')}`
}

/** What a failed call says about itself: the method, the path, the status, and a short body. */
const failed = (request: JiraRequest, status: number, body: string) => {
  const snippet = body.trim().slice(0, SNIPPET)
  return fleetError('external_failed', `jira ${request.method} ${request.path} answered ${status}${snippet === '' ? '' : `: ${snippet}`}`, {
    details: { method: request.method, path: request.path, status },
  })
}

export const createJiraClient = (options: JiraClientOptions): JiraClient => {
  const fetchImpl = options.fetch ?? defaultFetch
  const authorization = authorizationHeader(options.auth)
  const timeout = options.timeoutMillis ?? 20_000

  const send = async (request: JiraRequest): Promise<JiraCall> => {
    const headers: Record<string, string> = {
      authorization,
      accept: 'application/json',
    }
    if (request.body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await fetchImpl(urlOf(options.baseUrl, request), {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (thrown) {
      const reason = thrown instanceof Error ? thrown.message : String(thrown)
      // An abort is the one failure with an obvious next step, so it keeps its own code.
      const code = thrown instanceof Error && thrown.name === 'TimeoutError' ? 'timeout' : 'external_failed'
      throw fleetError(code, `jira ${request.method} ${request.path} could not be reached: ${reason}`, {
        cause: thrown,
        details: { method: request.method, path: request.path },
      })
    }
    return { status: response.status, ok: response.ok, read: () => response.text() }
  }

  const parse = (request: JiraRequest, call: JiraCall, body: string): unknown => {
    // A 204 has no body, and that is an answer — not a parse failure.
    if (body.trim() === '') return undefined
    try {
      return JSON.parse(body) as unknown
    } catch (thrown) {
      throw fleetError('external_failed', `jira ${request.method} ${request.path} printed no JSON`, {
        cause: thrown,
        details: { method: request.method, path: request.path, status: call.status },
      })
    }
  }

  return {
    send,
    async json(request) {
      const call = await send(request)
      const body = await call.read()
      if (!call.ok) throw failed(request, call.status, body)
      return parse(request, call, body)
    },
    async optional(request) {
      const call = await send(request)
      const body = await call.read()
      if (call.status === 404) return undefined
      if (!call.ok) throw failed(request, call.status, body)
      return { body: parse(request, call, body) }
    },
  }
}
