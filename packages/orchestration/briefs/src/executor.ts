/**
 * The executor for `assign` and `supersede_brief` (§5.2, §12).
 *
 * The PM decides and cannot publish: `decide` is pure, so the brief travels in
 * the action, complete (§4 `BriefHandoff`). This executor is where it becomes
 * real, in this order:
 *
 * 1. Read the Work and the peer and apply `rules.ts`.
 * 2. Append, in one atomic batch, `brief.published` and then either
 *    `work.assigned` (assign) or `brief.superseded` (supersede). The store
 *    projects the peer's brief version and the Work's current brief from
 *    `brief.published`, so the Mailbox's staleness check and the `stale` rule
 *    see the new brief the moment the batch lands.
 * 3. Send the brief to the peer through the Mailbox, as a `brief` message citing
 *    the version just published. Delivery (resume, wake) is the Mailbox's and the
 *    daemon's; this executor never talks to a provider.
 *
 * Events before the send, on purpose: a send that fails leaves a published brief
 * and an assigned Work, which is true, and the retry is safe — `rules.ts` treats
 * a brief that is already the Work's current one as done, and the send is skipped
 * when the same brief is already in the peer's mailbox. The other order could
 * deliver a brief the log never recorded.
 *
 * Every action is attempted, a refusal is an `ActionOutcome` with `ok: false`
 * and one sentence, and nothing throws (§5.2).
 */

import { systemClock, toFleetError, type Clock, type PeerId, type Seq, type WorkId } from '@fleet/foundation-core'
import type {
  ActionExecutor,
  ActionOutcome,
  AppendEvent,
  AssignAction,
  BriefHandoff,
  EventSink,
  ExecuteRequest,
  ExecutionReport,
  Mailbox,
  PmAction,
  ReadModel,
  SupersedeBriefAction,
} from '@fleet/foundation-contracts'
import { assignRefusal, describeBriefRefusal, supersedeRefusal, type BriefFacts } from './rules.ts'

export interface BriefExecutorDeps {
  readonly store: EventSink
  /** The two reads it needs; the full read model satisfies it. */
  readonly reads: {
    readonly work: Pick<ReadModel['work'], 'get'>
    readonly peers: Pick<ReadModel['peers'], 'get'>
  }
  /** `send` and `history` only: delivery is the Mailbox's, and this never asks for it. */
  readonly mailbox: Pick<Mailbox, 'send' | 'history'>
  readonly clock?: Clock
}

export interface BriefExecutor extends ActionExecutor {
  /** The kinds this executor carries out; the daemon routes the rest elsewhere (§5.2). */
  readonly kinds: readonly PmAction['kind'][]
  executeAssign(action: AssignAction): Promise<ActionOutcome>
  executeSupersede(action: SupersedeBriefAction): Promise<ActionOutcome>
}

const KINDS: readonly PmAction['kind'][] = ['assign', 'supersede_brief']

/** How many of a peer's recent messages are searched for an already-sent copy of the brief. */
const HISTORY_WINDOW = 100

const sameBrief = (
  message: { readonly kind: string; readonly briefVersion: number; readonly body: string },
  brief: BriefHandoff,
): boolean => message.kind === 'brief' && message.briefVersion === brief.version && message.body === brief.text

export const createBriefExecutor = (deps: BriefExecutorDeps): BriefExecutor => {
  const clock = deps.clock ?? systemClock

  const failed = (action: PmAction, error: string): ActionOutcome => ({ action, ok: false, seqs: [], error })

  const facts = async (workId: WorkId, peerId: PeerId): Promise<BriefFacts | { readonly error: string }> => {
    try {
      const [work, peer] = await Promise.all([deps.reads.work.get(workId), deps.reads.peers.get(peerId)])
      return { ...(work === undefined ? {} : { work }), ...(peer === undefined ? {} : { peer }) }
    } catch (thrown) {
      return { error: toFleetError(thrown, 'store_failed').message }
    }
  }

  const published = (action: AssignAction | SupersedeBriefAction): AppendEvent => ({
    type: 'brief.published',
    ts: clock.now(),
    subject: action.brief.briefId,
    actor: 'pm',
    causedBy: action.causedBy,
    data: {
      briefId: action.brief.briefId,
      workId: action.workId,
      peerId: action.peerId,
      version: action.brief.version,
      contractVersions: action.brief.contractVersions,
      text: action.brief.text,
    },
  })

  const append = async (
    events: readonly AppendEvent[],
  ): Promise<{ readonly seqs: readonly Seq[] } | { readonly error: string }> => {
    try {
      return { seqs: await deps.store.append(events) }
    } catch (thrown) {
      return { error: toFleetError(thrown, 'store_failed').message }
    }
  }

  /** Send the brief unless the peer's mailbox already holds this exact one. */
  const deliver = async (action: AssignAction | SupersedeBriefAction): Promise<string | undefined> => {
    const { brief, peerId } = action
    try {
      const recent = await deps.mailbox.history(peerId, HISTORY_WINDOW)
      if (recent.some((m) => sameBrief(m, brief))) return undefined
      const sent = await deps.mailbox.send({
        to: peerId,
        from: 'pm',
        kind: 'brief',
        briefVersion: brief.version,
        body: brief.text,
        causedBy: action.causedBy,
      })
      return sent.ok ? undefined : sent.error.message
    } catch (thrown) {
      return toFleetError(thrown, 'external_failed').message
    }
  }

  const afterEvents = async (
    action: AssignAction | SupersedeBriefAction,
    seqs: readonly Seq[],
  ): Promise<ActionOutcome> => {
    const problem = await deliver(action)
    if (problem !== undefined) {
      return {
        action,
        ok: false,
        seqs,
        error: `brief v${String(action.brief.version)} is published but the Mailbox refused it: ${problem}; running the action again is safe`,
      }
    }
    return { action, ok: true, seqs }
  }

  const executeAssign = async (action: AssignAction): Promise<ActionOutcome> => {
    const read = await facts(action.workId, action.peerId)
    if ('error' in read) return failed(action, read.error)
    const refusal = assignRefusal(action.brief, action.peerId, read)
    if (refusal !== undefined) {
      return failed(action, describeBriefRefusal(refusal, `assign ${String(action.workId)} to ${String(action.peerId)}`))
    }

    // Already the Work's brief: an earlier run wrote the events and failed at the send.
    if (read.work?.briefId === action.brief.briefId) return afterEvents(action, [])

    const written = await append([
      published(action),
      {
        type: 'work.assigned',
        ts: clock.now(),
        subject: action.workId,
        actor: 'pm',
        causedBy: action.causedBy,
        data: {
          workId: action.workId,
          peerId: action.peerId,
          briefId: action.brief.briefId,
          briefVersion: action.brief.version,
        },
      },
    ])
    if ('error' in written) return failed(action, written.error)
    return afterEvents(action, written.seqs)
  }

  const executeSupersede = async (action: SupersedeBriefAction): Promise<ActionOutcome> => {
    const read = await facts(action.workId, action.peerId)
    if ('error' in read) return failed(action, read.error)
    const refusal = supersedeRefusal(action, read)
    if (refusal !== undefined) {
      return failed(action, describeBriefRefusal(refusal, `supersede brief ${String(action.supersededBriefId)}`))
    }

    if (read.work?.briefId === action.brief.briefId) return afterEvents(action, [])

    const written = await append([
      published(action),
      {
        type: 'brief.superseded',
        ts: clock.now(),
        subject: action.supersededBriefId,
        actor: 'pm',
        causedBy: action.causedBy,
        data: {
          briefId: action.supersededBriefId,
          version: action.supersededVersion,
          supersededBy: action.brief.briefId,
          reason: action.reason.slice(0, 500),
        },
      },
    ])
    if ('error' in written) return failed(action, written.error)
    return afterEvents(action, written.seqs)
  }

  const executeOne = (action: PmAction): Promise<ActionOutcome> => {
    switch (action.kind) {
      case 'assign':
        return executeAssign(action)
      case 'supersede_brief':
        return executeSupersede(action)
      default:
        return Promise.resolve(
          failed(
            action,
            `the briefs executor does not execute '${action.kind}'; the daemon routes it to another executor (§5.2)`,
          ),
        )
    }
  }

  return {
    kinds: KINDS,
    executeAssign,
    executeSupersede,
    async execute(request: ExecuteRequest): Promise<ExecutionReport> {
      const outcomes: ActionOutcome[] = []
      for (const action of request.actions) outcomes.push(await executeOne(action))
      return {
        outcomes,
        executed: outcomes.filter((o) => o.ok).length,
        failed: outcomes.filter((o) => !o.ok).length,
      }
    },
  }
}
