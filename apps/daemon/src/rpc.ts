/**
 * The daemon's end of the socket (§2): JSON in, one typed call out, and a
 * failure that answers the client instead of taking `fleetd` down.
 *
 * Every shape on the wire is `foundation/contracts/daemon-rpc.ts` — the same
 * file the CLI builds against — so the protocol is spelled once and there is no
 * copy here to drift from it. What this file still owns is the daemon's own
 * business:
 *
 * - **Framing.** One line is one request; `encodeLine` is what the server writes
 *   and what a test reads, so both frame identically.
 * - **Decoding, per method.** `daemonParamsFor` is strict, so a mistyped field
 *   is answered as the client's fault and *named* (`params.to`), not blamed on
 *   the daemon as `internal`.
 * - **Dispatch.** The `switch` is exhaustive over `DaemonMethod`: a method added
 *   to the contract without a case here does not compile.
 */

import { fleetError, parseStrict, SchemaError, toFleetError, type FleetError, type Schema } from '@fleet/foundation-core'
import {
  daemonParamsFor,
  daemonRequest,
  type DaemonApi,
  type DaemonMethod,
  type DaemonRequest,
  type DaemonResponse,
} from '@fleet/foundation-contracts'

/**
 * Strict decode, with a schema failure reported as the client's fault.
 *
 * `parseStrict` throws a `SchemaError`, which is a `RangeError`: at this
 * boundary that is always the *client's* mistake, and answering `internal`
 * would blame the daemon for a bad request and hide the field that was wrong.
 */
const decode = <T>(schema: Schema<T>, value: unknown): T => {
  try {
    return parseStrict(schema, value)
  } catch (thrown) {
    if (thrown instanceof SchemaError) {
      throw fleetError('invalid_input', thrown.message, { cause: thrown, details: { issues: thrown.issues } })
    }
    throw thrown
  }
}

/** Decode one line into a request, or throw `invalid_input` naming what is wrong. */
export const decodeRequest = (line: string): DaemonRequest => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw fleetError('invalid_input', `the request is not JSON: ${(cause as Error).message}`, { cause })
  }
  return decode(daemonRequest(), value)
}

/**
 * Turn a request into a call. Each case decodes that method's own params, so the
 * error names the field the client got wrong rather than the generic "params is
 * invalid"; `?? {}` is what makes an absent `params` the same request as `{}` for
 * the four methods that take nothing.
 */
export const dispatch = async (api: DaemonApi, request: DaemonRequest): Promise<unknown> => {
  const params = request.params ?? {}
  switch (request.method) {
    case 'up':
      decode(daemonParamsFor('up'), params)
      return api.up()
    case 'down':
      decode(daemonParamsFor('down'), params)
      return api.down()
    case 'ls':
      decode(daemonParamsFor('ls'), params)
      return api.ls()
    case 'send':
      return api.send(decode(daemonParamsFor('send'), params))
    case 'peek':
      return api.peek(decode(daemonParamsFor('peek'), params))
    case 'decide':
      return api.decide(decode(daemonParamsFor('decide'), params))
    case 'usage':
      return api.usage(decode(daemonParamsFor('usage'), params))
    case 'events.append':
      return api.eventsAppend(decode(daemonParamsFor('events.append'), params))
    case 'evals':
      return api.evals(decode(daemonParamsFor('evals'), params))
  }
}

/**
 * One line in, one line out. A failure is a `DaemonResponse`, never a throw: the
 * socket writes the response and keeps serving, because a client that sent
 * nonsense must not be able to take the daemon down with it.
 *
 * `id` is echoed whenever it could be read, including on a failure — a client
 * with several requests in flight matches on it, and `daemonRequest` decoded the
 * envelope before any params failed.
 */
export const handleLine = async (api: DaemonApi, line: string): Promise<DaemonResponse> => {
  let id: string | undefined
  try {
    const request = decodeRequest(line)
    id = request.id
    return { ...(id === undefined ? {} : { id }), ok: true, result: await dispatch(api, request) }
  } catch (thrown) {
    const error = toFleetError(thrown, 'internal')
    return { ...(id === undefined ? {} : { id }), ok: false, error: errorBody(error) }
  }
}

const errorBody = (error: FleetError): { readonly code: string; readonly message: string } => ({
  code: error.code,
  message: error.message,
})

/** `encodeLine` exists so the server and the tests frame responses identically. */
export const encodeLine = (response: DaemonResponse): string => `${JSON.stringify(response)}\n`

/** Re-exported so an app that already holds this file's API type needs no second import. */
export type { DaemonApi, DaemonMethod, DaemonRequest, DaemonResponse }
