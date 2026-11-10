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
 * - **The site is https, from an origin, and does not redirect.** The token
 *   rides in a header, which a redirect would carry to whatever host answered,
 *   and a plain-http site puts it on the wire in the clear; both are refused
 *   once, at construction, and every request is built against that origin.
 * - **A body is read against a bound, never into memory.** A site that answers
 *   with a gigabyte is a failed call, not an out-of-memory in the daemon.
 */

import { fleetError } from '@fleet/foundation-core'
import { authorizationHeader, type JiraAuth } from './auth.ts'

/** The one thing this adapter takes from the platform, so a test needs no network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init)

/** Enough of a failed body to recognise it; a Jira error is a short JSON object. */
const SNIPPET = 200

/** The largest successful body this client will hold. A search page is far under it. */
const MAX_BODY = 8 * 1024 * 1024

/**
 * A body is whatever the site chose to send: a newline forges a second line in
 * the event log and an escape sequence repaints a terminal. Control characters
 * become spaces before any of it reaches a message people read.
 */
const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()

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
  /**
   * The first `limit` bytes of the body, cut rather than refused. An error wants
   * a snippet, so a body over the limit is still worth the start of it.
   */
  head(limit: number): Promise<string>
  /**
   * The whole body, or `external_failed` once it passes `limit` (default
   * `MAX_BODY`) — a body cut short must never come back as a parse failure.
   */
  read(limit?: number): Promise<string>
}

export interface JiraClientOptions {
  /** The site, e.g. `https://acme.atlassian.net`. A trailing slash is fine. */
  readonly baseUrl: string
  readonly auth: JiraAuth
  /** Defaults to `globalThis.fetch`. A test supplies a fake and reads the request it got. */
  readonly fetch?: FetchLike
  /** Defaults to 20s: a search that hangs is a failed routine, not a slow one. */
  readonly timeoutMillis?: number
  /**
   * Allow a plain-http site. Off by default: the token is a header on every
   * call, and http puts it on the wire for anyone on the path. For a local
   * install in a test, not for a site anyone else can reach.
   */
  readonly allowInsecureHttp?: boolean
  /** Defaults to 8 MiB. The bound on one successful body, so a test can make it small. */
  readonly maxBodyBytes?: number
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

/**
 * The one place a base URL is trusted. Kept as origin *and* path, because a
 * Server/DC install may live at a context path (`https://host/jira`) — dropping
 * it would silently send every call to the wrong place.
 */
const siteOf = (options: JiraClientOptions): { readonly base: string; readonly origin: string } => {
  let parsed: URL
  try {
    parsed = new URL(options.baseUrl)
  } catch {
    throw fleetError('invalid_input', `jira baseUrl "${options.baseUrl}" is not a URL`)
  }
  if (parsed.protocol !== 'https:' && !(options.allowInsecureHttp === true && parsed.protocol === 'http:')) {
    const scheme = parsed.protocol.replace(':', '')
    throw fleetError('invalid_input', `jira baseUrl must be https, not ${scheme}`, { details: { baseUrl: options.baseUrl } })
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw fleetError('invalid_input', 'jira baseUrl must not carry a username or password — the credential comes from the profile')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw fleetError('invalid_input', 'jira baseUrl must not carry a query or a fragment', { details: { baseUrl: options.baseUrl } })
  }
  return { base: `${parsed.origin}${trimSlash(parsed.pathname)}`, origin: parsed.origin }
}

const urlOf = (base: string, request: JiraRequest): string => {
  const url = `${base}${request.path}`
  const pairs = Object.entries(request.query ?? {}).flatMap(([key, value]) =>
    value === undefined ? [] : [`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`],
  )
  return pairs.length === 0 ? url : `${url}?${pairs.join('&')}`
}

/** What a failed call says about itself: the method, the path, the status, and a short body. */
const failed = (request: JiraRequest, status: number, body: string) => {
  const snippet = oneLine(body).slice(0, SNIPPET)
  return fleetError('external_failed', `jira ${request.method} ${request.path} answered ${status}${snippet === '' ? '' : `: ${snippet}`}`, {
    details: { method: request.method, path: request.path, status },
  })
}

/**
 * Read a body no further than `limit` bytes, and say whether there was more.
 * The stream is cancelled the moment the bound is passed, so the rest of a
 * hostile body is never pulled into memory.
 */
const readAtMost = async (response: Response, limit: number): Promise<{ readonly text: string; readonly cut: boolean }> => {
  const body = response.body
  if (body === null) return { text: '', cut: false }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return { text: text + decoder.decode(), cut: false }
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return { text: text + decoder.decode(), cut: true }
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

export const createJiraClient = (options: JiraClientOptions): JiraClient => {
  const fetchImpl = options.fetch ?? defaultFetch
  const authorization = authorizationHeader(options.auth)
  const timeout = options.timeoutMillis ?? 20_000
  const site = siteOf(options)
  const maxBody = options.maxBodyBytes ?? MAX_BODY

  const send = async (request: JiraRequest): Promise<JiraCall> => {
    const headers: Record<string, string> = {
      authorization,
      accept: 'application/json',
    }
    if (request.body !== undefined) headers['content-type'] = 'application/json'
    const url = urlOf(site.base, request)
    // Belt and braces: every path this adapter builds is relative to the site,
    // and a path that somehow resolved off it would carry the token there.
    if (new URL(url).origin !== site.origin) {
      throw fleetError('internal', `jira ${request.method} ${request.path} resolved off the site`, { details: { path: request.path } })
    }
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(timeout),
        // A redirect would replay the authorisation header at a host the site
        // named, so a moved site is a failure to report, not a hop to follow.
        redirect: 'error',
      })
    } catch (thrown) {
      const reason = oneLine(thrown instanceof Error ? thrown.message : String(thrown))
      // An abort is the one failure with an obvious next step, so it keeps its own code.
      const code = thrown instanceof Error && thrown.name === 'TimeoutError' ? 'timeout' : 'external_failed'
      throw fleetError(code, `jira ${request.method} ${request.path} could not be reached: ${reason}`, {
        cause: thrown,
        details: { method: request.method, path: request.path },
      })
    }
    return {
      status: response.status,
      ok: response.ok,
      head: async (limit) => (await readAtMost(response, limit)).text,
      read: async (limit = maxBody) => {
        const { text, cut } = await readAtMost(response, limit)
        if (cut) {
          throw fleetError('external_failed', `jira ${request.method} ${request.path} answered more than ${limit} bytes`, {
            details: { method: request.method, path: request.path, status: response.status },
          })
        }
        return text
      },
    }
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
      // Read the snippet, not the body: a failing site's answer is unbounded too.
      if (!call.ok) throw failed(request, call.status, await call.head(SNIPPET))
      return parse(request, call, await call.read())
    },
    async optional(request) {
      const call = await send(request)
      if (call.status === 404) {
        // Drain the answer so the connection is not left half-read; the body of
        // a 404 is nothing anyone needs.
        await call.head(SNIPPET)
        return undefined
      }
      if (!call.ok) throw failed(request, call.status, await call.head(SNIPPET))
      return { body: parse(request, call, await call.read()) }
    },
  }
}
