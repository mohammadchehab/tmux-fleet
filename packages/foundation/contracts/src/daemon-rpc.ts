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
  boolean,
  count,
  decisionId,
  evalRunId,
  literal,
  messageId,
  number,
  object,
  objectAs,
  oneOf,
  optional,
  peerId,
  positiveInt,
  refine,
  repo,
  seq,
  sessionId,
  sha,
  unknownRecord,
  workId,
  string,
  text,
  unionAs,
  type Seq,
  type SessionId,
  type WorkId,
  type DecisionId,
  type EvalRunId,
  type MessageId,
  type PeerId,
  type ProviderSessionRef,
  type Repo,
  type Schema,
  type Sha,
  providerSessionRef,
  record,
} from '@fleet/foundation-core'
import { attachCommand, type AttachCommand } from './provider.ts'
import { appendIssues, fleetEvent } from './events/registry.ts'
import type { AppendEvent, FleetEvent } from './events/registry.ts'
import { evalRunWithCases } from './projections/evals.ts'
import type { EvalRunWithCases } from './projections/evals.ts'
import { decision, routine, tokenReport } from './projections/ops.ts'
import type { Decision, Routine, TokenReport } from './projections/ops.ts'
import { message } from './projections/mailbox.ts'
import type { Message } from './projections/mailbox.ts'
import { peer, peerActivity, peerCompactions } from './projections/peers.ts'
import type { Peer, PeerActivity, PeerCompactions } from './projections/peers.ts'
import { work } from './projections/work.ts'
import type { Work } from './projections/work.ts'

import { build } from './projections/delivery.ts'
import type { Build } from './projections/delivery.ts'
import { buildCommand } from './shapes.ts'
import type { BuildCommand } from './shapes.ts'
import { turnKinds } from './provider.ts'
import type { TurnKind } from './provider.ts'
import { workNotePhase } from './work-state.ts'
import type { WorkNotePhase } from './work-state.ts'

// ----------------------------------------------------------------- envelope

/**
 * The closed set of things a client may ask for. `up` and `down` move the
 * daemon; `send`, `peek`, `decide` and `ls` are the fleet as the user sees it;
 * `usage` is how a peer's Stop hook reports a finished turn (§6.2); `replay`
 * re-derives the projections from the log, or hands back a window of it (§5.4).
 * A method added here without a case in `daemonParamsFor` does not compile, and
 * without a case in the daemon's dispatcher does not compile there either.
 */
export const daemonMethods = [
  'up',
  'down',
  'ls',
  'send',
  'peek',
  'decide',
  'usage',
  'note',
  'events.append',
  'evals',
  'replay',
  'work',

  'builds',
  // watch-and-attach §4, §7.2: one peer held for a person, or stopped, and back.
  'peer.hold',
  'peer.release',
  'peer.stop',
  'peer.start',
] as const
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
  /**
   * The wire protocol this daemon speaks (`daemonProtocolVersion`): bumped when a
   * stream frame or an RPC changes shape, so a client reads it on connect and
   * knows whether it can talk to this daemon.
   */
  readonly protocolVersion: number
  /**
   * Things the fleet started despite, in the user's words (TASK-12). The fleet is
   * up — a warning is not a refusal — but the profile asked for something the
   * provider cannot honour, and silence would let it look honoured. Omitted when
   * there is nothing to say, so an ordinary `fleet up` prints what it always did.
   */
  readonly warnings?: readonly string[]
}

export const daemonStatus = (): Schema<DaemonStatus> =>
  objectAs<DaemonStatus>()({
    profile: string({ minLength: 1, maxLength: 80 }),
    pid: positiveInt(),
    startedAt: string({ minLength: 1, maxLength: 40 }),
    socketPath: string({ minLength: 1, maxLength: 500 }),
    storePath: string({ minLength: 1, maxLength: 500 }),
    protocolVersion: positiveInt(),
    warnings: optional(array(string({ minLength: 1, maxLength: 500 }), { maxItems: 50 })),
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
  /**
   * The peer sending it. Absent means a person at a terminal, which the daemon
   * records as `user`. The CLI fills it from `FLEET_PEER`, which the daemon sets
   * for every session it starts and which a takeover sets too, so mail a peer
   * writes — headless or while a person drives it — is attributed to that peer.
   */
  readonly from?: PeerId
}

export const sendParams = (): Schema<SendParams> =>
  objectAs<SendParams>()({
    to: peerId(),
    kind: oneOf(turnKinds),
    body: text(100_000),
    briefVersion: optional(positiveInt()),
    from: optional(peerId()),
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

/**
 * `note`: a peer says where it has got to (§5.1), and the Work it is about is
 * *not* a parameter. A peer names no workId because a peer does not choose what
 * it is working on — the PM assigned it — so the daemon resolves the Work from
 * `assignee`, which is the one column that answers "what is this peer on". A
 * peer that passes a workId could describe someone else's Work, and a peer with
 * two open Works would have to pick one from a list it did not make.
 *
 * `peerId` is explicit for the same reason `usage`'s is: the caller is the peer,
 * and the daemon has no other way to know which session is on the socket. The
 * CLI fills it from `FLEET_PEER`, which the daemon sets for every session.
 */
export interface NoteParams {
  readonly peerId: PeerId
  readonly phase: WorkNotePhase
  readonly body: string
}

export const noteParams = (): Schema<NoteParams> =>
  objectAs<NoteParams>()({
    peerId: peerId(),
    phase: workNotePhase(),
    body: text(2000),
  })

/** The methods that take no arguments; `{}` and an absent `params` are the same request. */
export type NoParams = Readonly<Record<string, never>>

/**
 * `events.append`: the one write a client may do to the log, and it exists for
 * exactly one producer (§17).
 *
 * An eval run is dev tooling and may not import the daemon, while the store is
 * written by the daemon alone (`sql.ts`: one file, written by the daemon, read
 * by the CLI). The runner therefore hands its events over the socket instead of
 * opening the database a second time, which is what this method is.
 *
 * The restriction is the point: a general append would make every client a
 * second writer and retire the single-writer rule by accident. `eval.*` is the
 * whole of it — those are the events §17 says the adapter produces and nothing
 * in the runtime emits — and each one is checked against its own schema in
 * `appendIssues`, so the daemon never stores a shape the log's readers cannot
 * decode.
 */
export interface EventsAppendParams {
  readonly events: readonly AppendEvent[]
}

/** `eval.*` and nothing else: the prefix is the suite's, not the caller's, to claim. */
const isEvalAppendEvent = (event: AppendEvent): boolean =>
  typeof event.type === 'string' && event.type.startsWith('eval.') && appendIssues(event).length === 0

export const eventsAppendParams = (): Schema<EventsAppendParams> =>
  objectAs<EventsAppendParams>()({
    events: refine(
      array(unknownRecord()) as unknown as Schema<readonly AppendEvent[]>,
      (events) => events.length > 0 && events.every(isEvalAppendEvent),
      'events.append appends eval.* events only, at least one, each valid against its own contract schema',
    ),
  })

/**
 * `evals`: one run with its cases (§17). `fleet evals compare <runA> <runB>` is
 * the caller, so a run is asked for by id — there is no "every run" read here,
 * because a client that wanted one would be asking the daemon to hand over the
 * log's whole eval history to answer a question about two of them.
 */
export interface EvalsParams {
  readonly runId: EvalRunId
}

export const evalsParams = (): Schema<EvalsParams> =>
  objectAs<EvalsParams>()({
    runId: evalRunId(),
  })

/**
 * `replay`: the log, replayed (§5.4). Two questions, one method, because they
 * are the same walk over the same log:
 *
 * - no `from` — rebuild every projection from seq 1. This is the repair for a
 *   projection that disagrees with the log, and it is the daemon's to do: it
 *   holds the one writable handle (§1.1), so a client asking is asking for a
 *   write, not reading a database it opened itself.
 * - a `from` — hand back the events in `[from, to]` instead of writing
 *   anything. That is the debugging half: what the log says happened in the
 *   window around a tick.
 *
 * `to` without `from` names no window and is refused rather than quietly
 * ignored, because "rebuild everything" is a bigger thing to do than the typo
 * intended.
 */
export interface ReplayParams {
  readonly from?: Seq
  /** Inclusive; absent means "to the head". */
  readonly to?: Seq
}

export const replayParams = (): Schema<ReplayParams> =>
  objectAs<ReplayParams>()({
    from: optional(seq()),
    to: optional(seq()),
  })

/**
 * `builds`: a peer asks for a build (§11) — "a peer requests a build through the
 * API; the ledger returns the existing result or runs it once".
 *
 * The caller names the command because the ledger keys on the task and not on
 * what a task happens to run; the same task twice is the same build, and the
 * command of the second request is not read. `requestedBy` is optional because a
 * nightly eval is the scheduler's request, and §3 logs the two differently.
 */
export interface BuildsParams {
  readonly repo: Repo
  readonly sha: Sha
  /** `<class>[:<detail>…]`; the class is what routes the build to a host (§11). */
  readonly task: string
  readonly command: BuildCommand
  readonly requestedBy?: PeerId
}

export const buildsParams = (): Schema<BuildsParams> =>
  objectAs<BuildsParams>()({
    repo: repo(),
    sha: sha(),
    // The same bound the `build.*` events put on a task, so a request cannot ask
    // for a build the log would then refuse to record.
    task: string({ minLength: 1, maxLength: 100 }),
    command: buildCommand(),
    requestedBy: optional(peerId()),
  })

/**
 * `peer.hold` (watch-and-attach §4): stop one peer at its next turn boundary —
 * or at once, interrupting the turn, when `now` — and hand its session to a
 * person. Held again, it answers the same, so reopening a session whose terminal
 * died is the same call.
 */
export interface PeerHoldParams {
  readonly peerId: PeerId
  readonly now?: boolean
}

export const peerHoldParams = (): Schema<PeerHoldParams> =>
  objectAs<PeerHoldParams>()({ peerId: peerId(), now: optional(boolean()) })

/** `peer.release` and `peer.start`: the peer, and nothing else — the daemon knows its ref. */
export interface PeerParams {
  readonly peerId: PeerId
}

export const peerParams = (): Schema<PeerParams> => objectAs<PeerParams>()({ peerId: peerId() })

/** `peer.stop` (§7.2): as `peer.hold`, but nobody owns the session afterwards. */
export type PeerStopParams = PeerHoldParams
export const peerStopParams = peerHoldParams

/** Method → its params. The single place the two closed sets are tied together. */
export interface DaemonParams {
  readonly up: NoParams
  readonly down: NoParams
  readonly ls: NoParams
  readonly send: SendParams
  readonly peek: PeekParams
  readonly decide: DecideParams
  readonly usage: UsageParams
  readonly note: NoteParams
  readonly 'events.append': EventsAppendParams
  readonly evals: EvalsParams
  readonly replay: ReplayParams
  readonly work: NoParams
  readonly builds: BuildsParams
  readonly 'peer.hold': PeerHoldParams
  readonly 'peer.release': PeerParams
  readonly 'peer.stop': PeerStopParams
  readonly 'peer.start': PeerParams
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
  note: noteParams,
  'events.append': eventsAppendParams,
  evals: evalsParams,
  replay: replayParams,
  work: noParams,
  builds: buildsParams,
  'peer.hold': peerHoldParams,
  'peer.release': peerParams,
  'peer.stop': peerStopParams,
  'peer.start': peerParams,
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
  /**
   * One row per peer that has compacted, so `ls` can show a peer losing its
   * context (§8). A peer with no row has never compacted — the same fact as a
   * count of zero, without a row for every peer that is behaving.
   */
  readonly compactions: readonly PeerCompactions[]
  /**
   * §6.2's cost report, as the projection holds it: a row per peer and Work, and
   * a rollup row per peer with no `workId`. `ls` prints both rather than summing
   * here — a client that wanted one peer's total should not have to re-add rows.
   */
  readonly tokens: readonly TokenReport[]
  /**
   * What each peer is doing right now (§4): `state` says `working`, this says
   * at what. One row per peer with something to say.
   */
  readonly activity: readonly PeerActivity[]
}

export const lsResult = (): Schema<LsResult> =>
  objectAs<LsResult>()({
    status: daemonStatus(),
    peers: array(peer()),
    routines: array(routine()),
    decisions: array(decision()),
    compactions: array(peerCompactions()),
    tokens: array(tokenReport()),
    activity: array(peerActivity()),
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

/**
 * `note`: the Work the note landed on, and the phase it carried. The Work comes
 * back because the peer did not name it — it is the daemon's answer to "what am
 * I on", and a peer that read the reply learns which Work its words are on.
 */
export interface NoteResult {
  readonly workId: WorkId
  readonly phase: WorkNotePhase
}

export const noteResult = (): Schema<NoteResult> =>
  objectAs<NoteResult>()({ workId: workId(), phase: workNotePhase() })

/**
 * `events.append` answers with the seqs it wrote, in order: the store assigns
 * them (§3), so they are the only honest proof the batch landed. A caller that
 * cites a seq (an `eval.case_scored` caused by its `eval.run_started`) needs
 * the first one, which is why they come back positionally rather than as a
 * count.
 */
export interface EventsAppendResult {
  readonly seqs: readonly Seq[]
}

export const eventsAppendResult = (): Schema<EventsAppendResult> =>
  objectAs<EventsAppendResult>()({ seqs: array(number({ int: true, min: 1 })) as unknown as Schema<readonly Seq[]> })
/** `evals`: the run and its cases, as the two projections hold them — nothing reshaped on the way out. */
export type EvalsResult = EvalRunWithCases

/**
 * `replay`, whichever of its two questions was asked. `mode` discriminates
 * rather than an absent `latestSeq`, so a client cannot read a window as a
 * rebuild whose count went missing. A rebuild answers with the log's own
 * numbers, not with a claim about the rows: the projections were dropped and
 * re-derived, and what a reader can check afterwards is that the log is where
 * it was and that no projection row is left over from before.
 */
export interface ReplayRebuilt {
  readonly mode: 'rebuild'
  readonly events: number
  readonly latestSeq: Seq
}

/** A window of the log, oldest first — the events themselves, since nothing else can supply them. */
export interface ReplayWindow {
  readonly mode: 'window'
  readonly events: readonly FleetEvent[]
}

export type ReplayResult = ReplayRebuilt | ReplayWindow

export const replayResult = (): Schema<ReplayResult> =>
  unionAs<ReplayResult>()([
    objectAs<ReplayRebuilt>()({ mode: literal('rebuild'), events: count(), latestSeq: seq() }),
    objectAs<ReplayWindow>()({ mode: literal('window'), events: array(fleetEvent()) }),
  ])

/**
 * `work`: every Work item, with the state the projection holds (§3, §5.1).
 *
 * The board's read. It is a list rather than a query because a fleet's board is
 * small by construction — one squad's Work — and a filter here would be a second
 * opinion about which items exist. Each row is the projection's own `Work`, so a
 * client renders what the store knows instead of a shape invented for one caller
 * (§2).
 */
export interface WorkResult {
  readonly work: readonly Work[]
}

export const workResult = (): Schema<WorkResult> =>
  objectAs<WorkResult>()({
    // The same kind of bound every other list read carries: a projection past
    // this is a fleet bug, not an answer worth putting on a socket.
    work: array(work(), { maxItems: 2000 }),
  })

/**
 * `builds`: the build as the log now holds it, and whether *this* call ran it.
 * `deduped` is the answer to the question a peer actually asks — "did my
 * request start work?" — which a client cannot infer from the row (§11).
 */
export interface BuildsResult {
  readonly build: Build
  readonly deduped: boolean
}

export const buildsResult = (): Schema<BuildsResult> =>
  objectAs<BuildsResult>()({ build: build(), deduped: boolean() })

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
  readonly note: NoteResult
  readonly 'events.append': EventsAppendResult
  readonly evals: EvalsResult
  readonly replay: ReplayResult
  readonly work: WorkResult
  readonly builds: BuildsResult
  readonly 'peer.hold': PeerHoldResult
  readonly 'peer.release': PeerResumeResult
  readonly 'peer.stop': PeerStopResult
  readonly 'peer.start': PeerResumeResult
}

/**
 * What a takeover needs (watch-and-attach §4, §5): the session, where it runs,
 * the env the headless session got (keys included, which is why the socket is
 * its owner's alone), and the provider's own command for it. `pendingMessages`
 * is the mail that will wait until the release (§9).
 */
export interface PeerHoldResult {
  readonly peerId: PeerId
  readonly providerId: string
  readonly sessionRef: ProviderSessionRef
  readonly cwd: string
  readonly model: string
  readonly env: Readonly<Record<string, string>>
  readonly command: AttachCommand
  readonly pendingMessages: number
}

export const peerHoldResult = (): Schema<PeerHoldResult> =>
  objectAs<PeerHoldResult>()({
    peerId: peerId(),
    providerId: string({ minLength: 1 }),
    sessionRef: providerSessionRef(),
    cwd: string({ minLength: 1 }),
    model: string({ minLength: 1 }),
    env: record(string()),
    command: attachCommand(),
    pendingMessages: count(),
  })

/**
 * `peer.release` and `peer.start`: whether the parked session was resumed, and
 * when it was not, why the fresh start was taken instead (§4 "Resume failing").
 */
export interface PeerResumeResult {
  readonly peerId: PeerId
  readonly resumed: boolean
  readonly reason?: string
}

export const peerResumeResult = (): Schema<PeerResumeResult> =>
  objectAs<PeerResumeResult>()({ peerId: peerId(), resumed: boolean(), reason: optional(text(500)) })

/** `peer.stop`: the ref the peer will resume from, absent when it had no session to stop. */
export interface PeerStopResult {
  readonly peerId: PeerId
  readonly sessionRef?: ProviderSessionRef
}

export const peerStopResult = (): Schema<PeerStopResult> =>
  objectAs<PeerStopResult>()({ peerId: peerId(), sessionRef: optional(providerSessionRef()) })

export type DaemonResultOf<M extends DaemonMethod> = DaemonResults[M]

const resultSchemas: { readonly [M in DaemonMethod]: () => Schema<DaemonResults[M]> } = {
  up: daemonStatus,
  down: downResult,
  ls: lsResult,
  send: sendResult,
  peek: peekResult,
  decide: decision,
  usage: usageResult,
  note: noteResult,
  'events.append': eventsAppendResult,
  evals: evalRunWithCases,
  replay: replayResult,
  work: workResult,
  builds: buildsResult,
  'peer.hold': peerHoldResult,
  'peer.release': peerResumeResult,
  'peer.stop': peerStopResult,
  'peer.start': peerResumeResult,
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
  /**
   * A peer says where it has got to (§5.1). The Work is resolved from the peer's
   * assignee, not named by it — see `NoteParams`.
   */
  note(params: NoteParams): Promise<NoteResult>
  /**
   * Append `eval.*` events, and only those (§17). The single write a client has:
   * an eval runner is dev tooling that may not import the daemon, and the store
   * has one writer, so the runner hands its events over the socket.
   */
  eventsAppend(params: EventsAppendParams): Promise<EventsAppendResult>
  /** One eval run with its cases (§17); `fleet evals compare` reads two of these. */
  evals(params: EvalsParams): Promise<EvalsResult>
  /**
   * Re-derive the projections from the log, or hand back a window of it (§5.4).
   * The daemon's because it owns the writable handle: a rebuild from a client
   * would be a second writer on the same store.
   */
  replay(params: ReplayParams): Promise<ReplayResult>
  /**
   * Every Work item and the state the projection holds it in (§3, §5.1). The
   * board's read, and the tmux view's next: a client that wants the board
   * should not have to open the store or watch the log.
   */
  work(): Promise<WorkResult>
  /**
   * Request a build (§11): the existing result for `(repo, sha, task)`, or one
   * run. The daemon owns the ledger, so a fleet shares one answer — a second
   * peer asking for the same triple waits on the first request rather than
   * starting a second build.
   */
  builds(params: BuildsParams): Promise<BuildsResult>
  /** Hold one peer for a person, at the next turn boundary or now (watch-and-attach §4). */
  /** `signal` aborts when the client's connection closes, so a hold waiting for a turn is dropped with it. */
  peerHold(params: PeerHoldParams, signal?: AbortSignal): Promise<PeerHoldResult>
  /** Give a held peer back to fleetd: resume its session with a handback note. */
  peerRelease(params: PeerParams): Promise<PeerResumeResult>
  /** Stop one peer, with nobody holding it (§7.2). */
  peerStop(params: PeerStopParams, signal?: AbortSignal): Promise<PeerStopResult>
  /** Start one stopped peer, from its ref when it has one (§7.2). */
  peerStart(params: PeerParams): Promise<PeerResumeResult>
}
