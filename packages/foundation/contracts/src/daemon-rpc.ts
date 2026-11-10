/**
 * The daemon's local API (architecture §2): JSON over a Unix socket, one request
 * and one response per line, no state held by the client.
 *
 * `fleetd` serves it and every client speaks it — the CLI today, the board and
 * the tmux view after that. It lives in `contracts` because it is a **port
 * between two apps**, and §1.1 forbids one app importing another: without this
 * file the CLI would have to copy the shapes out of `apps/daemon`, and the two
 * would drift the first time a row gained a field.
 *
 * Three things shape it:
 *
 * - **The envelope is fixed; the payload is not.** `method` decides the shape of
 *   `params` and of `result`, so the envelope leaves both as `unknown` and each
 *   method decodes its own (`daemonParamsFor`). A client that misspells a field
 *   then gets "`params.to`: expected a peer id" rather than "params is invalid".
 * - **Rows are the projections.** `ls` returns `Peer`/`Routine`/`Decision` and
 *   `peek` returns `Message` — the same types the store's reader produces. A
 *   flattened twin per method would be a second spelling of one row, which is
 *   exactly what `shapes.ts` exists to prevent.
 * - **`ls` carries the decision inbox.** §6.1 makes the inbox visible in
 *   `fleet ls` and `fleet decide`; a `decide` that could only answer, never
 *   list, would force a seventh method to do what one row list already does.
 *
 * Nothing here is behaviour: schemas and interfaces only, as the package's
 * index says. Framing (splitting lines off the socket) and error mapping stay
 * with the daemon.
 */

import {
  array,
  count,
  decisionId,
  literal,
  messageId,
  number,
  object,
  objectAs,
  oneOf,
  optional,
  peerId,
  positiveInt,
  sessionId,
  workId,
  string,
  text,
  unionAs,
  type SessionId,
  type WorkId,
  type DecisionId,
  type MessageId,
  type PeerId,
  type Schema,
} from '@fleet/foundation-core'
import { decision, routine } from './projections/ops.ts'
import type { Decision, Routine } from './projections/ops.ts'
import { message } from './projections/mailbox.ts'
import type { Message } from './projections/mailbox.ts'
import { peer } from './projections/peers.ts'
import type { Peer } from './projections/peers.ts'
import { turnKinds } from './provider.ts'
import type { TurnKind } from './provider.ts'

// ----------------------------------------------------------------- envelope

/**
 * The closed set of things a client may ask for. `up` and `down` move the
 * daemon; `send`, `peek`, `decide` and `ls` are the fleet as the user sees it;
 * `usage` is how a peer's Stop hook reports a finished turn (§6.2). A method added here
 * without a case in `daemonParamsFor` does not compile, and without a case in
 * the daemon's dispatcher does not compile there either.
 */
export const daemonMethods = ['up', 'down', 'ls', 'send', 'peek', 'decide', 'usage'] as const
export type DaemonMethod = (typeof daemonMethods)[number]

/**
 * `unknown` by design: `params` and `result` are decoded per method, so the
 * envelope never rejects a well-formed request on behalf of a method it does
 * not know the shape of. It is also what lets a client read a response before
 * it knows which method answered — the `ok` flag is all it needs to branch.
 */
const passthrough = <T>(): Schema<T> => ({ tag: 'unknown', decode: (value) => value as T })

/**
 * One line from a client. `id` is echoed on the response and never interpreted,
 * so a client with several requests in flight can match them; a daemon that
 * dropped it would make the CLI's one-at-a-time assumption a requirement
 * instead of a choice.
 */
export interface DaemonRequest {
  readonly id?: string
  readonly method: DaemonMethod
  readonly params?: unknown
}

export const daemonRequest = (): Schema<DaemonRequest> =>
  objectAs<DaemonRequest>()({
    id: optional(string({ minLength: 1, maxLength: 64 })),
    method: oneOf(daemonMethods),
    params: optional(passthrough<unknown>()),
  })

/** The `code` of a §1.1 `FleetError`, as a client sees it. */
export interface DaemonErrorBody {
  readonly code: string
  readonly message: string
}

/**
 * One line back. `ok` discriminates rather than an absent `error`, so a client
 * cannot read a successful `{}` result as a failure. A failed request is a
 * response, never a dropped connection: a client that sent nonsense must not be
 * able to take the daemon down (§2).
 */
export interface DaemonOk {
  readonly id?: string
  readonly ok: true
  readonly result: unknown
}

export interface DaemonFailed {
  readonly id?: string
  readonly ok: false
  readonly error: DaemonErrorBody
}

export type DaemonResponse = DaemonOk | DaemonFailed

const idField = () => optional(string({ minLength: 1, maxLength: 64 }))

const daemonErrorBody = (): Schema<DaemonErrorBody> =>
  objectAs<DaemonErrorBody>()({
    code: string({ minLength: 1, maxLength: 40 }),
    message: text(2000),
  })

export const daemonResponse = (): Schema<DaemonResponse> =>
  unionAs<DaemonResponse>()([
    objectAs<DaemonOk>()({ id: idField(), ok: literal(true), result: passthrough<unknown>() }),
    objectAs<DaemonFailed>()({ id: idField(), ok: literal(false), error: daemonErrorBody() }),
  ])

// --------------------------------------------------------------------- rows

/**
 * What every reply about the daemon itself repeats: which profile it is, the
 * process, and where its socket and store are. `fleet ls` carries it as well as
 * `up`, so a client that attached to an already-running daemon still learns
 * everything `up` would have told it.
 */
export interface DaemonStatus {
  readonly profile: string
  readonly pid: number
  readonly startedAt: string
  readonly socketPath: string
  readonly storePath: string
}

export const daemonStatus = (): Schema<DaemonStatus> =>
  objectAs<DaemonStatus>()({
    profile: string({ minLength: 1, maxLength: 80 }),
    pid: positiveInt(),
    startedAt: string({ minLength: 1, maxLength: 40 }),
    socketPath: string({ minLength: 1, maxLength: 500 }),
    storePath: string({ minLength: 1, maxLength: 500 }),
  })

// -------------------------------------------------------------------- params

/** `send`: §7's only way to a peer. The Mailbox assigns the id and the time. */
export interface SendParams {
  readonly to: PeerId
  readonly kind: TurnKind
  readonly body: string
  /**
   * The brief the message was written against. Omitted means "whatever the peer
   * is on", which is what a human typing `fleet send` means; the daemon fills it
   * from the peer's current version rather than trusting the client's copy (§7).
   */
  readonly briefVersion?: number
}

export const sendParams = (): Schema<SendParams> =>
  objectAs<SendParams>()({
    to: peerId(),
    kind: oneOf(turnKinds),
    body: text(100_000),
    briefVersion: optional(positiveInt()),
  })

/** `peek`: a peer's messages, oldest first — the last `limit`, defaulting to the whole box. */
export interface PeekParams {
  readonly peer: PeerId
  readonly limit?: number
}

export const peekParams = (): Schema<PeekParams> =>
  objectAs<PeekParams>()({
    peer: peerId(),
    limit: optional(count()),
  })

/**
 * `decide`: the user answers an open decision (§6.1). The answer is recorded on
 * the PM's next tick, not by the daemon, so this names the option and nothing
 * else — `decision` is checked against the decision's own closed set.
 */
export interface DecideParams {
  readonly id: DecisionId
  readonly decision: string
  readonly note?: string
}

export const decideParams = (): Schema<DecideParams> =>
  objectAs<DecideParams>()({
    id: decisionId(),
    decision: text(200),
    note: optional(text(2000)),
  })

/**
 * `usage`: one finished turn, as a peer's Stop hook measured it (§6.2). The
 * fields are `turn.usage_recorded`'s, so the daemon appends that event without
 * inferring anything. `contextLimit` comes from the profile, never from the
 * transcript (§4): a hook that guessed it would make the purge trigger a guess.
 */
export interface UsageParams {
  readonly peerId: PeerId
  readonly sessionId?: SessionId
  readonly workId?: WorkId
  readonly contextTokens: number
  readonly contextLimit: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  /** How the turn spent its exploration (§6.2): the guard is measured, not assumed. */
  readonly toolCalls: { readonly grep: number; readonly glob: number; readonly read: number; readonly codegraph: number }
  readonly costUsd?: number
}

export const usageParams = (): Schema<UsageParams> =>
  objectAs<UsageParams>()({
    peerId: peerId(),
    sessionId: optional(sessionId()),
    workId: optional(workId()),
    contextTokens: count(),
    contextLimit: positiveInt(),
    inputTokens: count(),
    outputTokens: count(),
    cachedTokens: count(),
    toolCalls: object({ grep: count(), glob: count(), read: count(), codegraph: count() }),
    costUsd: optional(number({ min: 0 })),
  })

/** The methods that take no arguments; `{}` and an absent `params` are the same request. */
export type NoParams = Readonly<Record<string, never>>

/** Method → its params. The single place the two closed sets are tied together. */
export interface DaemonParams {
  readonly up: NoParams
  readonly down: NoParams
  readonly ls: NoParams
  readonly send: SendParams
  readonly peek: PeekParams
  readonly decide: DecideParams
  readonly usage: UsageParams
}

export type DaemonParamsOf<M extends DaemonMethod> = DaemonParams[M]

/** Strict, so a client that sends `{"limit": 3}` to `ls` is told it does nothing rather than ignored. */
const noParams = (): Schema<NoParams> => object({}) as unknown as Schema<NoParams>

const paramsSchemas: { readonly [M in DaemonMethod]: () => Schema<DaemonParamsOf<M>> } = {
  up: noParams,
  down: noParams,
  ls: noParams,
  send: sendParams,
  peek: peekParams,
  decide: decideParams,
  usage: usageParams,
}

/** The schema for one method's params; what both the daemon and the CLI validate against. */
export const daemonParamsFor = <M extends DaemonMethod>(method: M): Schema<DaemonParamsOf<M>> =>
  paramsSchemas[method]()

// ------------------------------------------------------------------- results

/** `up` answers with the status it reached; running `up` twice is not an error (§2). */
export type UpResult = DaemonStatus

/** `down`: stopped, if it was running. Answers before the socket closes, so the CLI is not left hanging. */
export interface DownResult {
  readonly stopped: true
}

export const downResult = (): Schema<DownResult> => objectAs<DownResult>()({ stopped: literal(true) })

/**
 * `ls`: the fleet in one read. Peers and routines are the store's projections;
 * `decisions` is the open inbox of §6.1, so one command shows both what is
 * running and what is waiting on the user.
 */
export interface LsResult {
  readonly status: DaemonStatus
  readonly peers: readonly Peer[]
  readonly routines: readonly Routine[]
  readonly decisions: readonly Decision[]
}

export const lsResult = (): Schema<LsResult> =>
  objectAs<LsResult>()({
    status: daemonStatus(),
    peers: array(peer()),
    routines: array(routine()),
    decisions: array(decision()),
  })

/** `send`: the id the Mailbox minted, so the client can find it in `peek`. */
export interface SendResult {
  readonly msgId: MessageId
}

export const sendResult = (): Schema<SendResult> => objectAs<SendResult>()({ msgId: messageId() })

/** `peek`: the peer's messages, oldest first. A `Message` is the §7 projection, not a wire copy. */
export interface PeekResult {
  readonly messages: readonly Message[]
}

export const peekResult = (): Schema<PeekResult> => objectAs<PeekResult>()({ messages: array(message()) })

/** `decide` answers with the decision as it now stands — answered, with the option recorded. */
export type DecisionRow = Decision

/** `usage`: recorded. The event's own seq is not the client's business. */
export interface UsageResult {
  readonly recorded: true
}

export const usageResult = (): Schema<UsageResult> => objectAs<UsageResult>()({ recorded: literal(true) })

// ------------------------------------------------------------ results table

/**
 * Method → its result type. The counterpart of `DaemonParams`, and the reason a
 * client writes no table of its own: with `daemonResultFor` it can refuse an
 * answer that is not the method's own result before rendering it, so a daemon
 * that drifted from this file is loud in the client rather than quietly
 * displayed as `undefined` in a table.
 */
export interface DaemonResults {
  readonly up: UpResult
  readonly down: DownResult
  readonly ls: LsResult
  readonly send: SendResult
  readonly peek: PeekResult
  readonly decide: DecisionRow
  readonly usage: UsageResult
}

export type DaemonResultOf<M extends DaemonMethod> = DaemonResults[M]

const resultSchemas: { readonly [M in DaemonMethod]: () => Schema<DaemonResults[M]> } = {
  up: daemonStatus,
  down: downResult,
  ls: lsResult,
  send: sendResult,
  peek: peekResult,
  decide: decision,
  usage: usageResult,
}

/** The schema for one method's result. The exhaustive key type is what makes a new method a compile error. */
export const daemonResultFor = <M extends DaemonMethod>(method: M): Schema<DaemonResults[M]> =>
  resultSchemas[method]()

// --------------------------------------------------------------------- port

/**
 * What the daemon implements and the CLI calls, typed. Every method is async
 * because every one of them is a store read or write or a provider call.
 *
 * The daemon narrows the wire to these arguments and nothing else: `rpc` knows
 * what a peer id is, the daemon's loop code never sees a string from a socket.
 */
export interface DaemonApi {
  /** Start the loops if they are not running; idempotent, because `fleet up` may be run twice (§2). */
  up(): Promise<UpResult>
  down(): Promise<DownResult>
  ls(): Promise<LsResult>
  /** §7's only way to a peer: the Mailbox writes the event and delivers. */
  send(params: SendParams): Promise<SendResult>
  peek(params: PeekParams): Promise<PeekResult>
  /** Answer an open decision (§6.1). The decision event is written by the PM's next tick, not here. */
  decide(params: DecideParams): Promise<DecisionRow>
  /** Record one turn's usage as `turn.usage_recorded`; what the `token-report` projection reads (§6.2). */
  usage(params: UsageParams): Promise<UsageResult>
}
