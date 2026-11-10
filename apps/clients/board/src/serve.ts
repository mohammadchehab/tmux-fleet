/**
 * The board over HTTP (§2): one route, `/`, and it is a read.
 *
 * Every request re-reads the daemon — `ls` for the header and `work` for the
 * rows — and renders the answer. Nothing is cached and nothing is written, so
 * there is no state for two tabs to disagree about, and a reload *is* the
 * refresh. A daemon that is not answering gets a page that says so with a 503
 * rather than a socket error in a browser's console, because "fleetd is down"
 * is a thing a person needs to read.
 *
 * The listener takes its socket path, host and port as arguments and returns
 * how to reach it and how to stop it. It never reads the environment and never
 * exits the process: `main.ts` does both.
 *
 * It answers only under the names it was asked to serve — loopback and its
 * configured host — because a page the board does not know has no business
 * reading a fleet's Work (§2, DNS rebinding).
 */

import { createServer } from 'node:http'
import type { AddressInfo, Server } from 'node:net'

import { toFleetError } from '@fleet/foundation-core'

import type { Caller } from './client.ts'
import { renderBoard, renderUnreachable } from './render.ts'

export interface ServeOptions {
  readonly socketPath: string
  readonly host: string
  /** 0 asks the OS for a free port; `url` below reports the one it chose. */
  readonly port: number
  readonly call: Caller
  /** ISO-8601, supplied rather than read from the clock so a test's page is stable. */
  readonly now: () => string
}

export interface RunningBoard {
  /** The address a browser opens, e.g. `http://127.0.0.1:7777/`. */
  readonly url: string
  stop(): Promise<void>
}

/**
 * The names a browser may put in `Host`: the loopback names it would use to
 * open the board, and whatever `--host` bound to.
 *
 * This is the whole defence against DNS rebinding (§2). A hostile page points
 * its own name at 127.0.0.1; the browser keeps the *name* in `Host` and still
 * considers the page same-origin with its own site, so without this check its
 * script reads the fleet's rows. The name is the attack, so the name is what is
 * checked — the connection's source address is not, because by then the
 * browser has already sent it from loopback.
 */
const allowedHosts = (configured: string): ReadonlySet<string> =>
  new Set(['localhost', '127.0.0.1', '::1', configured.toLowerCase()])

/** The name half of `Host: name`, `name:port`, `[::1]` or `[::1]:port`; undefined when the line carries none. */
const hostNameOf = (header: string | undefined): string | undefined => {
  const value = header?.trim().toLowerCase() ?? ''
  if (value === '') return undefined
  // a bracketed address is already isolated from its port, brackets and all
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    return close < 0 ? undefined : value.slice(1, close)
  }
  // only a single colon can be the port's: `::1` sent bare has several
  const colon = value.lastIndexOf(':')
  return colon < 0 || value.indexOf(':') !== colon ? value : value.slice(0, colon)
}

const htmlHeaders: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // A read-only page that loads nothing external has nothing to relax, and
  // framing a fleet's board inside someone else's page is not a thing to allow.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
}

/** Read both answers, or the page that says the daemon is not there. */
const page = async (options: ServeOptions): Promise<{ readonly status: number; readonly body: string }> => {
  try {
    const [ls, work] = await Promise.all([options.call('ls', {}), options.call('work', {})])
    return {
      status: 200,
      body: renderBoard({
        status: ls.status,
        work: work.work,
        usage: ls.tokens,
        activity: ls.activity,
        renderedAt: options.now(),
      }),
    }
  } catch (thrown) {
    // Any failure here is the daemon's, not the request's: the board has no
    // input of its own, so a page that cannot be read is a page that says which
    // socket was not answering.
    const problem = toFleetError(thrown).message
    return { status: 503, body: renderUnreachable(options.socketPath, problem, options.now()) }
  }
}

export const serveBoard = async (options: ServeOptions): Promise<RunningBoard> => {
  const allowed = allowedHosts(options.host)

  const server: Server = createServer((request, response) => {
    // first, and before the daemon is read: a request arriving under a name the
    // board does not answer to is refused, not served — and a refusal must not
    // depend on a read having happened
    const host = hostNameOf(request.headers.host)
    if (host === undefined || !allowed.has(host)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      response.end('the board answers only for 127.0.0.1, localhost, [::1] and its configured host\n')
      return
    }

    const path = (request.url ?? '/').split('?')[0] ?? '/'
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      response.end('the board is read-only: GET / is the whole surface\n')
      return
    }
    if (path !== '/' && path !== '/index.html') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('no such page; the board serves / and nothing else\n')
      return
    }
    void page(options).then((rendered) => {
      response.writeHead(rendered.status, htmlHeaders)
      response.end(rendered.body)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo | null
  const port = address === null ? options.port : address.port
  // `::1`/`::` need brackets in a URL; a plain v4 host does not.
  const host = options.host.includes(':') ? `[${options.host}]` : options.host
  return {
    url: `http://${host}:${String(port)}/`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
  }
}
