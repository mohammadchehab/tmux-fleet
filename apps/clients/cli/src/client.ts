/**
 * One request to `fleetd` over its socket (§2): a JSON line out, a JSON line
 * back, and nothing else.
 *
 * Every shape here comes from `@fleet/foundation-contracts/daemon-rpc.ts` and
 * none is re-declared: the params are checked with `daemonParamsFor` before a
 * socket is opened (so a mistyped argument fails in the CLI, not in the
 * daemon), and the answer is checked with `daemonResponse` and the method's
 * result schema. A daemon that has drifted from the contract is loud here
 * rather than quietly rendered as `undefined` in a table.
 *
 * The client holds no state: one connection, one request, one answer, closed.
 * A fleet is a local process, so a request that needs longer than `timeoutMs`
 * is a bug on one end or the other, not something to wait through.
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
  /** Default 30 s: a local daemon that has not answered by then is not going to. */
  readonly timeoutMs?: number
}

/** The CLI's whole view of the daemon: one typed call per method of the port. */
export type DaemonCaller = <M extends DaemonMethod>(method: M, params: DaemonParamsOf<M>) => Promise<DaemonResults[M]>

/**
 * True for "there is nobody at that socket" — the one failure `fleet up` may
 * answer by starting a daemon instead of by reporting an error. Anything the
 * daemon *said* is not this: a refusal is a refusal.
 */
export const isUnreachable = (error: unknown): boolean => error instanceof FleetError && error.code === 'external_failed'

const refuseParams = <T>(schema: Schema<T>, value: unknown, method: string): T => {
  try {
    return parseStrict(schema, value)
  } catch (thrown) {
    if (thrown instanceof SchemaError) {
      throw fleetError('invalid_input', `${method}: ${thrown.message}`, { cause: thrown, details: { issues: thrown.issues } })
    }
    throw thrown
  }
}

/**
 * One value from the command line, decoded with the contract's own schema for
 * that field, so `fleet send ../etc info hi` is refused here with the field
 * named instead of travelling to the daemon and coming back. `callDaemon`
 * decodes the whole params object again; that is not redundant, it is the
 * daemon's copy of the same rule.
 */
export const asArgument = <T>(schema: Schema<T>, value: unknown, what: string): T => {
  try {
    return parseStrict(schema, value)
  } catch (thrown) {
    if (thrown instanceof SchemaError) {
      throw fleetError('invalid_input', `${what}: ${describe(thrown)}`, { cause: thrown, details: { issues: thrown.issues } })
    }
    throw thrown
  }
}

const refuseAnswer = <T>(schema: Schema<T>, value: unknown, what: string): T => {
  try {
    return parseStrict(schema, value)
  } catch (thrown) {
    if (thrown instanceof SchemaError) {
      throw fleetError('internal', `fleetd's ${what} does not match the daemon API contract: ${describe(thrown)}`, {
        cause: thrown,
        details: { issues: thrown.issues },
      })
    }
    throw thrown
  }
}

/** `<root>: expected a valid PeerId` reads badly in a CLI message; the path is for `details.issues`. */
const describe = (error: SchemaError): string => error.message.replace(/^<root>: /, '')

/**
 * Async even though only the last line waits: a refused argument is a rejected
 * promise too, so a caller that only ever sees `await` cannot be surprised by
 * a synchronous throw from one branch and not another.
 */
export const callDaemon = async <M extends DaemonMethod>(
  options: CallOptions,
  method: M,
  params: DaemonParamsOf<M>,
): Promise<DaemonResults[M]> => {
  // Checked before connecting: a bad argument is the CLI's own fault and should
  // not need a daemon to notice it.
  const checked = refuseParams(daemonParamsFor(method), params, method)
  const timeoutMs = options.timeoutMs ?? 30_000

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
      socket.write(`${JSON.stringify({ id: method, method, params: checked })}\n`)
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

      // `refuseAnswer` throws, and a throw inside an event handler would escape
      // the promise and take the process down instead of rejecting it.
      try {
        const response = refuseAnswer(daemonResponse(), value, 'answer')
        if (!response.ok) {
          fail(fleetError(isFleetErrorCode(response.error.code) ? response.error.code : 'internal', response.error.message))
          return
        }
        const result = refuseAnswer(daemonResultFor(method), response.result, `${method} result`)
        finish(() => {
          resolve(result)
        })
      } catch (thrown) {
        fail(thrown instanceof FleetError ? thrown : fleetError('internal', String(thrown), { cause: thrown }))
      }
    })
  })
}

/** A caller bound to one socket, which is what `run` hands each command. */
export const callerFor = (options: CallOptions): DaemonCaller => {
  const call = <M extends DaemonMethod>(method: M, params: DaemonParamsOf<M>): Promise<DaemonResults[M]> =>
    callDaemon(options, method, params)
  return call
}
