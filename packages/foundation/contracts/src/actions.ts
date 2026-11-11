/**
 * What the PM decides, and who performs it (architecture §5.2, §5.4, §6, §10).
 *
 * `decide` returns actions; they are executed afterwards and their effects are
 * events (§5.2). Two consequences shape this file:
 *
 * - **An action is data with a schema.** The PM's output is recorded, replayed
 *   and diffed (§5.4), and it crosses from `orchestration/pm` to whatever
 *   executes it, so it is a closed union with a strict decode at that boundary.
 *   An unknown field is an error, not a misspelt option silently dropped.
 * - **An action carries `causedBy`.** The event seqs the decision was made from
 *   (§3), so every effect can be traced to what the PM saw, and a replay can
 *   tell "same inputs, different action" from "inputs moved".
 *
 * The executor is a port, not an implementation: `orchestration/pm` may not
 * import `runtime/mailbox` or `integrations/github` (§1.1), and a rule that
 * merged its own PR would be a second place §10 is decided.
 */

import {
  array,
  objectAs,
  oneOf,
  optional,
  positiveInt,
  refine,
  seq,
  sha,
  string,
  text,
  unionAs,
  type Schema,
} from '@fleet/foundation-core'
import { briefId, decisionId, peerId, questionId, workId } from '@fleet/foundation-core'
import type { BriefId, DecisionId, PeerId, QuestionId, Seq, Sha, WorkId } from '@fleet/foundation-core'
import { judgeInput, questionKind } from './judge.ts'
import type { JudgeInput, QuestionKind } from './judge.ts'
import type { BriefHandoff } from './provider.ts'
import { briefHandoff, turnKinds } from './provider.ts'
import type { TurnKind } from './provider.ts'
import { branchName, line, pullRequestRef } from './shapes.ts'
import type { PullRequestRef } from './shapes.ts'
import { blockReason } from './work-state.ts'
import type { BlockReason } from './work-state.ts'

/** The closed list of things a tick may decide. A sixth rule is a new variant, not a wider field. */
export const pmActionKinds = [
  'assign',
  'supersede_brief',
  'send_message',
  'request_judge',
  'request_decision',
  'merge',
  'retarget',
  'flag_capacity',
  'raise_no_work',
  'render_standup',
  'mark_ready',
  'block_work',
] as const
export type PmActionKind = (typeof pmActionKinds)[number]

const causedBy = () => array(seq(), { maxItems: 50 })

/** A brief or contract version: 1-based, so `0` is always a mistake. */
const version = (): Schema<number> => positiveInt()

/** The merge methods git offers. §10's `delete-branch` is deliberately absent (see `MergeAction`). */
export const mergeMethods = ['merge', 'squash', 'rebase'] as const
export type MergeMethod = (typeof mergeMethods)[number]

/** What every action shares: what it is, and what it was decided from. */
export interface PmActionBase {
  readonly kind: PmActionKind
  /** The event seqs the PM read to decide this. Never empty in practice (§5.4). */
  readonly causedBy: readonly Seq[]
}

// ------------------------------------------------------------------- effects

/**
 * The `assign` rule (§5.2): write Brief v+1, send it, `Work → assigned`.
 *
 * The brief travels *inside* the action, complete. `decide` is pure and has no
 * store, so it cannot publish and then hand over an id; and a brief the
 * executor had to re-derive would be a second copy of the text the peer is
 * judged against (§12).
 */
export interface AssignAction extends PmActionBase {
  readonly kind: 'assign'
  readonly workId: WorkId
  readonly peerId: PeerId
  readonly brief: BriefHandoff
}

/**
 * The `stale` rule (§5.2, §12): a contract moved on, so the brief the peer holds
 * names a version that is no longer the contract. The old brief stays readable;
 * the replacement is sent with `supersede_brief`.
 */
export interface SupersedeBriefAction extends PmActionBase {
  readonly kind: 'supersede_brief'
  readonly workId: WorkId
  readonly peerId: PeerId
  /** The brief the peer's context currently carries. */
  readonly supersededBriefId: BriefId
  readonly supersededVersion: number
  /** The replacement, complete: the executor publishes it, then supersedes the old one. */
  readonly brief: BriefHandoff
  readonly reason: string
}

/**
 * A message the PM decides to send: a nudge with failing checks cited, an answer
 * from the `Decision` log (§5.2 `unblock`), an FYI. Briefs are `assign` or
 * `supersede_brief`, never a message.
 */
export interface SendMessageAction extends PmActionBase {
  readonly kind: 'send_message'
  readonly to: PeerId
  readonly messageKind: TurnKind
  readonly body: string
  /** The brief version the message was written against; a stale reply is rejected (§7). */
  readonly briefVersion: number
}

/**
 * The `dedupe`/`unblock`/`thin_card` path (§5.3): a question no rule can answer.
 * The fields are `judge.requested`'s, so the executor writes that event without
 * inferring anything.
 */
export interface RequestJudgeAction extends PmActionBase {
  readonly kind: 'request_judge'
  readonly questionId: QuestionId
  readonly question: QuestionKind
  readonly input: JudgeInput
  /** The hash of the inputs the question was formed from, for replay (§5.4). */
  readonly inputsHash: string
  readonly workId?: WorkId
  /** The peer whose work raised it, when one did. */
  readonly askedFor?: PeerId
}

/**
 * §5.1's `proposed → ready`, as the PM's decision. Nothing else may move a Work
 * out of `proposed`: the state machine is event-driven, and this is the event's
 * decision half, so the executor writes `work.ready` without deciding whether
 * the card deserves it.
 */
export interface MarkReadyAction extends PmActionBase {
  readonly kind: 'mark_ready'
  readonly workId: WorkId
  /** Why the card needs no answer; it lands on the event, so the log says what the rule saw. */
  readonly reason?: string
}

/**
 * §5.1's transition into `blocked`, as the PM's decision: a peer said it is stuck (`work.noted`, phase `blocked`) and
 * the PM records it. The executor writes `work.blocked` only for a Work the peer holds, and not one already blocked,
 * so a block is recorded once per transition (TASK-126).
 */
export interface BlockWorkAction extends PmActionBase {
  readonly kind: 'block_work'
  readonly workId: WorkId
  /** The peer whose note this is: the executor blocks only while it still holds the Work (TASK-126). */
  readonly peerId: PeerId
  readonly reason: string
  readonly blockedOn: BlockReason
}

/**
 * Something blocks on the user (§6.1): a product or scope call, an approval, a
 * Judge question that escalated. It becomes an open row in the decision inbox
 * and a "needs your decision" notification, and the Work it names stays put.
 */
export interface RequestDecisionAction extends PmActionBase {
  readonly kind: 'request_decision'
  readonly decisionId: DecisionId
  /** The decision's own kind, e.g. `scope` or `approval`; the action's `kind` is above. */
  readonly decisionKind: string
  readonly question: string
  readonly options: readonly string[]
  readonly workId?: WorkId
  readonly inputsHash: string
  /** Who could answer it, when it is not the user. */
  readonly routedTo?: string
}

/**
 * The `merge` rule (§5.2, §10). The PM never merges: it asks, and the gate
 * merges only the head sha whose checks it saw green.
 *
 * There is no `deleteBranch`. §10 forbids deleting a branch a stacked dependent
 * still sits on, and an action that cannot say it cannot get it wrong — the
 * executor picks, because only it can see the dependents.
 */
export interface MergeAction extends PmActionBase {
  readonly kind: 'merge'
  readonly pr: PullRequestRef
  /** The sha the checks were green on; the gate refuses to merge anything else (§10). */
  readonly headSha: Sha
  readonly method: MergeMethod
}

/** A stack parent merged: dependents move onto the parent's base before anything is merged (§10). */
export interface RetargetAction extends PmActionBase {
  readonly kind: 'retarget'
  readonly pr: PullRequestRef
  readonly toBase: string
}

/**
 * The `idle` rule's first half (§5.2): this peer is free. A capacity fact, not a
 * state change — a peer's state comes from its provider (§4), so the PM must not
 * write one it cannot observe.
 */
export interface FlagCapacityAction extends PmActionBase {
  readonly kind: 'flag_capacity'
  readonly peerId: PeerId
  readonly reason: string
}

/**
 * The `idle` rule's second half (§5.2): nothing is assignable and someone is
 * free. Raised to the user **once** per dry spell; the executor dedupes, because
 * only it can see whether it already said so.
 */
export interface RaiseNoWorkAction extends PmActionBase {
  readonly kind: 'raise_no_work'
  /** The role that is dry; absent when the whole fleet is. */
  readonly role?: string
  readonly reason: string
}

/**
 * The `standup` routine's half of §5.2 (§6, §6.1): render today's report. The
 * PM decides *that* it is due; the renderer and `standup.rendered` belong to the
 * executor, which is where the projections are formatted and the peers counted.
 */
export interface RenderStandupAction extends PmActionBase {
  readonly kind: 'render_standup'
  /** `YYYY-MM-DD`, the local day the standup is for; matches `standup.rendered`. */
  readonly date: string
}

export type PmAction =
  | AssignAction
  | SupersedeBriefAction
  | SendMessageAction
  | RequestJudgeAction
  | RequestDecisionAction
  | MergeAction
  | RetargetAction
  | FlagCapacityAction
  | RaiseNoWorkAction
  | RenderStandupAction
  | MarkReadyAction
  | BlockWorkAction

// -------------------------------------------------------------------- schemas

const assignAction = (): Schema<AssignAction> =>
  objectAs<AssignAction>()({
    kind: oneOf(['assign'] as const),
    causedBy: causedBy(),
    workId: workId(),
    peerId: peerId(),
    brief: briefHandoff(),
  })

const supersedeBriefAction = (): Schema<SupersedeBriefAction> =>
  objectAs<SupersedeBriefAction>()({
    kind: oneOf(['supersede_brief'] as const),
    causedBy: causedBy(),
    workId: workId(),
    peerId: peerId(),
    supersededBriefId: briefId(),
    supersededVersion: version(),
    brief: briefHandoff(),
    reason: text(500),
  })

const sendMessageAction = (): Schema<SendMessageAction> =>
  objectAs<SendMessageAction>()({
    kind: oneOf(['send_message'] as const),
    causedBy: causedBy(),
    to: peerId(),
    messageKind: oneOf(turnKinds),
    body: text(100_000),
    briefVersion: version(),
  })

const requestJudgeAction = (): Schema<RequestJudgeAction> =>
  refine(
    objectAs<RequestJudgeAction>()({
      kind: oneOf(['request_judge'] as const),
      causedBy: causedBy(),
      questionId: questionId(),
      question: questionKind(),
      input: judgeInput(),
      inputsHash: string({ minLength: 8, maxLength: 200 }),
      workId: optional(workId()),
      askedFor: optional(peerId()),
    }),
    (value) => value.input.kind === value.question,
    'a judge question whose input matches its kind',
  )

const requestDecisionAction = (): Schema<RequestDecisionAction> =>
  objectAs<RequestDecisionAction>()({
    kind: oneOf(['request_decision'] as const),
    causedBy: causedBy(),
    decisionId: decisionId(),
    decisionKind: string({ minLength: 1, maxLength: 60 }),
    question: text(2000),
    options: array(string({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
    workId: optional(workId()),
    inputsHash: string({ minLength: 8, maxLength: 200 }),
    routedTo: optional(string({ minLength: 1, maxLength: 80 })),
  })

const mergeAction = (): Schema<MergeAction> =>
  objectAs<MergeAction>()({
    kind: oneOf(['merge'] as const),
    causedBy: causedBy(),
    pr: pullRequestRef(),
    headSha: sha(),
    method: oneOf(mergeMethods),
  })

const retargetAction = (): Schema<RetargetAction> =>
  objectAs<RetargetAction>()({
    kind: oneOf(['retarget'] as const),
    causedBy: causedBy(),
    pr: pullRequestRef(),
    toBase: branchName(),
  })

const flagCapacityAction = (): Schema<FlagCapacityAction> =>
  objectAs<FlagCapacityAction>()({
    kind: oneOf(['flag_capacity'] as const),
    causedBy: causedBy(),
    peerId: peerId(),
    reason: text(500),
  })

const raiseNoWorkAction = (): Schema<RaiseNoWorkAction> =>
  objectAs<RaiseNoWorkAction>()({
    kind: oneOf(['raise_no_work'] as const),
    causedBy: causedBy(),
    role: optional(line(80)),
    reason: text(1000),
  })

const renderStandupAction = (): Schema<RenderStandupAction> =>
  objectAs<RenderStandupAction>()({
    kind: oneOf(['render_standup'] as const),
    causedBy: causedBy(),
    date: string({ pattern: /^\d{4}-\d{2}-\d{2}$/ }),
  })

const markReadyAction = (): Schema<MarkReadyAction> =>
  objectAs<MarkReadyAction>()({
    kind: oneOf(['mark_ready'] as const),
    causedBy: causedBy(),
    workId: workId(),
    reason: optional(text(500)),
  })

const blockWorkAction = (): Schema<BlockWorkAction> =>
  objectAs<BlockWorkAction>()({
    kind: oneOf(['block_work'] as const),
    causedBy: causedBy(),
    workId: workId(),
    peerId: peerId(),
    reason: text(1000),
    blockedOn: blockReason(),
  })

const actionSchemas: { readonly [K in PmActionKind]: () => Schema<Extract<PmAction, { readonly kind: K }>> } = {
  assign: assignAction,
  supersede_brief: supersedeBriefAction,
  send_message: sendMessageAction,
  request_judge: requestJudgeAction,
  request_decision: requestDecisionAction,
  merge: mergeAction,
  retarget: retargetAction,
  mark_ready: markReadyAction,
  block_work: blockWorkAction,
  flag_capacity: flagCapacityAction,
  raise_no_work: raiseNoWorkAction,
  render_standup: renderStandupAction,
}

/**
 * The schema for one kind; what an executor validates a single action against
 * when it already knows which one it holds. Strictly decoded at that boundary,
 * so a `deleteBranch` on a `merge` is refused rather than ignored.
 */
export const pmActionFor = <K extends PmActionKind>(kind: K): Schema<Extract<PmAction, { readonly kind: K }>> =>
  actionSchemas[kind]()

/** The union, for a batch: the variant is decided by `kind`, as `fleetEvent` does for events. */
export const pmAction = (): Schema<PmAction> =>
  unionAs<PmAction>()([
    assignAction(),
    supersedeBriefAction(),
    sendMessageAction(),
    requestJudgeAction(),
    requestDecisionAction(),
    mergeAction(),
    retargetAction(),
    flagCapacityAction(),
    raiseNoWorkAction(),
    renderStandupAction(),
    blockWorkAction(),
    markReadyAction(),
  ])

// ------------------------------------------------------------------- executor

/** What one action did. A batch reports each, in the order the PM emitted them. */
export interface ActionOutcome {
  readonly action: PmAction
  readonly ok: boolean
  /** The events it wrote, in order. Empty when it failed before writing one. */
  readonly seqs: readonly Seq[]
  /** Why it failed, when it did. Bounded, because it ends up in `routine.finished.actionsFailed`'s run record. */
  readonly error?: string
}

/**
 * Executing a tick's actions. `executed` counts the ones that happened;
 * `failed` is what a routine records as `actionsFailed` (§6) — an action the PM
 * decided and the fleet could not carry out is a visible gap, not a silent one.
 */
export interface ExecutionReport {
  readonly outcomes: readonly ActionOutcome[]
  readonly executed: number
  readonly failed: number
}

export interface ExecuteRequest {
  readonly actions: readonly PmAction[]
  /** The run that decided them, so the events an action writes can cite it (§6). */
  readonly routineId: string
  /** The event that woke the run, when one did (§3 `causedBy`). */
  readonly causedBySeq?: Seq
}

/**
 * Who performs what the PM decided (§5.2). Implemented by `apps/daemon` over the
 * Mailbox (§7), `PullRequests`/the PR gate (§10) and the standup renderer
 * (§6.1), and faked in every routine test.
 *
 * Every action in a batch is attempted, in order, even after one fails: they
 * were all decided from the same state and none is a precondition the PM wrote
 * as another action. A `Fail` is a `FleetError`'s message on the outcome, never
 * a throw — a tick that threw would lose the rest of its actions.
 */
export interface ActionExecutor {
  execute(request: ExecuteRequest): Promise<ExecutionReport>
}
