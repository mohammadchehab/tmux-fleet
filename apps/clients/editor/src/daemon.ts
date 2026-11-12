/**
 * One request to `fleetd` over its socket (§2, §7): a JSON line out, a JSON line
 * back, nothing else.
 *
 * This is the same thirty lines of framing `apps/clients/view` writes out, and
 * written out again on purpose: apps never import each other (§1.1). What would
 * hurt to keep in two places — what a `Peer` is, what `decide` takes — is in
 * `@fleet/foundation-contracts`, and both directions are checked against it
 * here, so a daemon that drifted is loud instead of rendering as `undefined`.
 *
 * Three methods is the whole of what this window needs: `ls` for the tree,
 * `decide` for a decision row, `send` for a message. Everything else the
 * extension does is a `fleet` command in a terminal (§6), which is the point —
 * a takeover in the editor and a takeover in a shell must not be two code paths.
 */

import { createConnection } from 'node:net'

import { parseStrict } from '@fleet/foundation-core'
import {
  daemonParamsFor,
  daemonResponse,
  daemonResultFor,
  type DaemonMethod,
  type DaemonParamsOf,
  type DaemonResults,
  type DecideParams,
  type LsResult,
  type SendParams,
  watchFrame,
} from '@fleet/foundation-contracts'

import type { OpenWatch } from './output.ts'

/** Default 5 s: the tree redraws on a short tick, so a slow answer is stale, not worth waiting for. */
const TIMEOUT_MS = 5_000

/**
 * One call, one connection. Rejects with whatever `fleetd` said, or with a
 * plain `Error` naming the socket when it could not be reached — the caller
 * turns either into a state, never into a stack trace in a notification.
 */
export const callDaemon = async <M extends DaemonMethod>(
  socketPath: string,
  method: M,
  params: DaemonParamsOf<M>,
  timeoutMs: number = TIMEOUT_MS,
): Promise<DaemonResults[M]> => {
  // Checked before a socket is opened: a bad argument is this client's own
  // fault and should not need a daemon to notice it.
  const sent = parseStrict(daemonParamsFor(method), params) as unknown

  return new Promise<DaemonResults[M]>((resolve, reject) => {
    let buffer = ''
    let settled = false

    const socket = createConnection(socketPath)
    socket.setEncoding('utf8')

    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      socket.destroy()
      settle()
    }
    const fail = (error: Error): void =>
      finish(() => {
        reject(error)
      })

    socket.setTimeout(timeoutMs, () =>
      fail(new Error(`fleetd did not answer ${method} within ${String(timeoutMs)} ms`)),
    )
    socket.on('error', (error: NodeJS.ErrnoException) =>
      fail(new Error(`cannot reach fleetd at ${socketPath}: ${error.message}`, { cause: error })),
    )
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: method, method, params: sent })}\n`)
    })
    socket.on('close', () =>
      fail(new Error(`fleetd at ${socketPath} closed the connection without answering`)),
    )
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return

      // A throw inside a handler would escape the promise and take the window
      // down instead of rejecting it.
      try {
        const response = parseStrict(daemonResponse(), JSON.parse(buffer.slice(0, newline)))
        if (!response.ok) {
          fail(new Error(response.error.message))
          return
        }
        const result = parseStrict(daemonResultFor(method), response.result) as DaemonResults[M]
        finish(() => {
          resolve(result)
        })
      } catch (thrown) {
        fail(thrown instanceof Error ? thrown : new Error(String(thrown)))
      }
    })
  })
}

/** What the window asks of one daemon, bound to its socket. */
export interface FleetDaemon {
  readonly ls: () => Promise<LsResult>
  readonly decide: (params: DecideParams) => Promise<unknown>
  readonly send: (params: SendParams) => Promise<unknown>
}

export const daemonAt = (socketPath: string): FleetDaemon => ({
  ls: async () => callDaemon(socketPath, 'ls', {}),
  decide: async (params) => callDaemon(socketPath, 'decide', params),
  send: async (params) => callDaemon(socketPath, 'send', params),
})

/**
 * The one long connection (§5): `peer.watch`, a request line out and frames
 * until either side closes. Frames are checked against the contract; a line
 * that is not one ends the stream, because a daemon that drifted should be loud.
 * The same framing `apps/clients/cli` writes, written again because apps never
 * import each other (§1.1).
 */
export const watchDaemon: OpenWatch = ({ socketPath, since, onFrame, onClose }) => {
  const socket = createConnection(socketPath)
  socket.setEncoding('utf8')
  let buffer = ''
  let done = false
  const finish = (error?: Error): void => {
    if (done) return
    done = true
    socket.destroy()
    onClose(error)
  }
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ id: 'watch', method: 'peer.watch', params: since === undefined ? {} : { since } })}\n`)
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      try {
        onFrame(parseStrict(watchFrame(), JSON.parse(line)))
      } catch (thrown) {
        finish(thrown instanceof Error ? thrown : new Error(String(thrown)))
        return
      }
    }
  })
  socket.on('error', (error) => finish(error))
  socket.on('close', () => finish())
  return { close: () => finish() }
}
