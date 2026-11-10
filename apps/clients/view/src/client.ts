/**
 * One request to `fleetd` over its socket (§2): a JSON line out, a JSON line
 * back, and nothing else.
 *
 * Every shape comes from `@fleet/foundation-contracts` and none is re-declared:
 * the params are checked with `daemonParamsFor` before a socket is opened, and
 * the answer is checked with `daemonResponse` and the method's result schema. A
 * daemon that has drifted from the contract is loud here rather than quietly
 * rendered as `undefined` in a pane.
 *
 * The framing is written out rather than imported from the CLI, because apps
 * never import each other (§1.1). It is thirty lines of `node:net`; the part
 * that would hurt to keep in two places — what a `Peer` is — is in the contract.
 *
 * The client holds no state: one connection, one request, one answer, closed.
 * The view asks again on its next tick, which is why a pane that lost the
 * daemon recovers by itself when the daemon comes back.
 */

import { createConnection } from 'node:net'

import { FleetError, fleetError, isFleetErrorCode, parseStrict, SchemaError, type Schema } from '@fleet/foundation-core'
import {
  daemonParamsFor,
  daemonResponse,
  daemonResultFor,
  type DaemonMethod,
  type DaemonParamsOf,
  type DaemonResults,
} from '@fleet/foundation-contracts'

export interface CallOptions {
  readonly socketPath: string
  /** Default 5 s: a view pane redraws on a short tick, so a slow answer is stale, not worth waiting for. */
  readonly timeoutMs?: number
}

/** The whole view's access to the daemon: one typed call per method of the API. */
export type Caller = <M extends DaemonMethod>(method: M, params: DaemonParamsOf<M>) => Promise<DaemonResults[M]>

/** `<root>: expected a valid PeerId` reads badly in a pane; the path is for `details.issues`. */
const describe = (error: SchemaError): string => error.message.replace(/^<root>: /, '')

const checked = <T>(schema: Schema<T>, value: unknown, what: string, code: 'invalid_input' | 'internal'): T => {
  try {
    return parseStrict(schema, value)
  } catch (thrown) {
    if (thrown instanceof SchemaError) {
      throw fleetError(code, `${what}: ${describe(thrown)}`, { cause: thrown, details: { issues: thrown.issues } })
    }
    throw thrown
  }
}

export const callDaemon = async <M extends DaemonMethod>(
  options: CallOptions,
  method: M,
  params: DaemonParamsOf<M>,
): Promise<DaemonResults[M]> => {
  // Before connecting: a bad argument is this client's own fault and should not
  // need a daemon to notice it.
  const sent = checked(daemonParamsFor(method), params, method, 'invalid_input')
  const timeoutMs = options.timeoutMs ?? 5_000

  return new Promise<DaemonResults[M]>((resolve, reject) => {
    let buffer = ''
    let settled = false

    const socket = createConnection(options.socketPath)
    socket.setEncoding('utf8')

    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      socket.destroy()
      settle()
    }
    const fail = (error: FleetError): void =>
      finish(() => {
        reject(error)
      })

    socket.setTimeout(timeoutMs, () =>
      fail(fleetError('timeout', `fleetd did not answer ${method} within ${String(timeoutMs)} ms`)),
    )
    socket.on('error', (error: NodeJS.ErrnoException) =>
      fail(
        fleetError('external_failed', `cannot reach fleetd at ${options.socketPath}: ${error.message}`, {
          cause: error,
          details: { socketPath: options.socketPath, errno: error.code },
        }),
      ),
    )
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: method, method, params: sent })}\n`)
    })
    socket.on('close', () =>
      fail(fleetError('external_failed', `fleetd at ${options.socketPath} closed the connection without answering`)),
    )
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return

      let value: unknown
      try {
        value = JSON.parse(buffer.slice(0, newline))
      } catch (cause) {
        fail(fleetError('internal', 'fleetd answered with something that is not JSON', { cause }))
        return
      }

      // A throw inside a handler would escape the promise and take the pane
      // down instead of rejecting it.
      try {
        const response = checked(daemonResponse(), value, 'answer', 'internal')
        if (!response.ok) {
          fail(fleetError(isFleetErrorCode(response.error.code) ? response.error.code : 'internal', response.error.message))
          return
        }
        const result = checked(daemonResultFor(method), response.result, `${method} result`, 'internal')
        finish(() => {
          resolve(result)
        })
      } catch (thrown) {
        fail(thrown instanceof FleetError ? thrown : fleetError('internal', String(thrown), { cause: thrown }))
      }
    })
  })
}

/** A caller bound to one socket, which is what a pane and a grid each hold. */
export const callerFor = (options: CallOptions): Caller => {
  const call = <M extends DaemonMethod>(method: M, params: DaemonParamsOf<M>): Promise<DaemonResults[M]> =>
    callDaemon(options, method, params)
  return call
}
