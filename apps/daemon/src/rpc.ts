/**
 * The daemon's local API (architecture §2): JSON over a Unix socket, one request
 * and one response per line, no state held by the client.
 *
 * **This file is a stand-in.** `foundation/contracts/daemon-rpc.ts` is being
 * written by the CLI's author and is the authority for the wire shape; when it
 * lands, the schemas and envelope below are replaced by its exports and
 * `apps/clients/cli` needs no change, because the *methods* are already the six
 * the CLI is being built against — `up`, `down`, `ls`, `send`, `peek`, `decide`.
 * Keeping the request/response types here rather than in `contracts` is the one
 * place this app anticipates a port instead of consuming one, so it is marked
 * loudly rather than buried in a comment.
 *
 * The split that matters is not the wire format but `DaemonApi`: the handler
 * narrows unknown JSON to typed arguments and nothing else. `rpc.ts` never
 * knows what a peer is; `daemon.ts` never sees a string from a socket.
 */

import {
  count,
  decisionId,
  fleetError,
  object,
  objectAs,
  oneOf,
  optional,
  parseStrict,
  peerId,
  text,
  toFleetError,
  type FleetError,
  type PeerId,
  type DecisionId,
  type Schema,
} from '@fleet/foundation-core'
import { turnKinds, type TurnKind } from '@fleet/foundation-contracts'

/** `fleet ls`: one line per peer, plus what the scheduler is running (§2, §6). */
export interface PeerRow {
  readonly id: PeerId
  readonly role: string
  readonly provider: string
  /** §8's state: `idle`, `working`, `waiting_on_user`, `blocked`, `failed`, `offline`. */
  readonly state: string
  /** Unacked messages, so `fleet ls` can show a peer that is not being reached. */
  readonly pending: number
  readonly sessionId?: string
}

export interface RoutineRow {
  readonly id: string
  readonly kind: string
  /** §6's projection state: `idle`, `running`, `failed`, … */
  readonly state: string
  readonly runs: number
  readonly failures: number
  readonly lastRunAt?: string
}

/** What `up` reports, and what `ls` repeats so a client can show a running fleet. */
export interface DaemonStatus {
  readonly profile: string
  readonly pid: number
  readonly startedAt: string
  readonly socketPath: string
  readonly storePath: string
}

/** A decision as `fleet decide` sees it: the question, the closed set of answers, and where it stands. */
export interface DecisionRow {
  readonly id: DecisionId
  readonly kind: string
  readonly state: string
  readonly question: string
  readonly options: readonly string[]
  readonly requestedAt: string
}

/**
 * What the RPC can do, typed. `daemon.ts` implements it; the CLI reaches it
 * through the socket. Every method is async because every one of them is a
 * store write or a provider call.
 */
export interface DaemonApi {
  /** Start the loops if they are not running; idempotent, because `fleet up` may be run twice (§2). */
  up(): Promise<DaemonStatus>
  /** Stop the loops and the server. Answers before the process exits, so the CLI is not left hanging. */
  down(): Promise<{ readonly stopped: true }>
  ls(): Promise<{ readonly status: DaemonStatus; readonly peers: readonly PeerRow[]; readonly routines: readonly RoutineRow[] }>
  /** §7's only way to a peer: the Mailbox writes the event and delivers. */
  send(input: {
    readonly to: PeerId
    readonly kind: TurnKind
    readonly body: string
    readonly briefVersion?: number
  }): Promise<{ readonly msgId: string }>
  /** §7: the peer's messages, oldest first — what `fleet peek` shows. */
  peek(input: { readonly peer: PeerId; readonly limit?: number }): Promise<{ readonly messages: readonly PeekedMessage[] }>
  /** Answer an open decision (§6.1). The decision event is written by the PM's next tick, not here. */
  decide(input: { readonly id: DecisionId; readonly decision: string; readonly note?: string }): Promise<DecisionRow>
}

/** A message as a client reads it: the projection row, flattened for the wire. */
export interface PeekedMessage {
  readonly msgId: string
  readonly from: string
  readonly to: string
  readonly kind: string
  readonly body: string
  readonly state: string
  readonly sentAt: string
}

// ------------------------------------------------------------------ the wire

export const rpcMethods = ['up', 'down', 'ls', 'send', 'peek', 'decide'] as const
export type RpcMethod = (typeof rpcMethods)[number]

export interface RpcRequest {
  /** Echoed back, so a client can match a response to its request. */
  readonly id?: string
  readonly method: RpcMethod
  readonly params?: unknown
}

export type RpcResponse =
  | { readonly id?: string; readonly ok: true; readonly result: unknown }
  | { readonly id?: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface RpcErrorBody {
  readonly code: string
  readonly message: string
}

const requestSchema = (): Schema<RpcRequest> =>
  objectAs<RpcRequest>()({
    id: optional(text(64)),
    method: oneOf(rpcMethods),
    params: optional(anything()),
  })

/**
 * `params` stays `unknown` here on purpose: each method decodes its own, so the
 * error names the field the client got wrong (`params.to`) rather than the
 * generic "params is invalid".
 */
const anything = (): Schema<unknown> => ({ tag: 'unknown', decode: (value) => value })

/** Decode one line into a request, or throw `invalid_input` naming what is wrong. */
export const decodeRequest = (line: string): RpcRequest => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw fleetError('invalid_input', `the request is not JSON: ${(cause as Error).message}`, { cause })
  }
  return parseStrict(requestSchema(), value)
}

const sendParams = () =>
  objectAs<{ to: PeerId; kind: TurnKind; body: string; briefVersion?: number }>()({
    to: peerId(),
    kind: oneOf(turnKinds),
    body: text(100_000),
    briefVersion: optional(count()),
  })

const peekParams = () =>
  objectAs<{ peer: PeerId; limit?: number }>()({
    peer: peerId(),
    limit: optional(count()),
  })

const decideParams = () =>
  objectAs<{ id: DecisionId; decision: string; note?: string }>()({
    id: decisionId(),
    decision: text(200),
    note: optional(text(2000)),
  })

const noParams = (): Schema<Record<string, never>> => object({}) as unknown as Schema<Record<string, never>>

/**
 * Turn a method + params into a call. The `switch` is exhaustive over
 * `RpcMethod`, so a method added to the union without a case fails to compile
 * rather than answering `undefined` at runtime.
 */
export const dispatch = async (api: DaemonApi, request: RpcRequest): Promise<unknown> => {
  switch (request.method) {
    case 'up':
      parseStrict(noParams(), request.params ?? {})
      return api.up()
    case 'down':
      parseStrict(noParams(), request.params ?? {})
      return api.down()
    case 'ls':
      parseStrict(noParams(), request.params ?? {})
      return api.ls()
    case 'send':
      return api.send(parseStrict(sendParams(), request.params ?? {}))
    case 'peek':
      return api.peek(parseStrict(peekParams(), request.params ?? {}))
    case 'decide':
      return api.decide(parseStrict(decideParams(), request.params ?? {}))
  }
}

/**
 * One line in, one line out. A failure is an `RpcResponse`, never a throw: the
 * socket writes the response and keeps serving, because a client that sent
 * nonsense must not be able to take the daemon down with it.
 */
export const handleLine = async (api: DaemonApi, line: string): Promise<RpcResponse> => {
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

const errorBody = (error: FleetError): RpcErrorBody => ({ code: error.code, message: error.message })

/** `encodeLine` exists so the server and the tests frame responses identically. */
export const encodeLine = (response: RpcResponse): string => `${JSON.stringify(response)}\n`
