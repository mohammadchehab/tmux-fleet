/**
 * §5.1's Work state machine, driven from the events that already exist.
 *
 * The machine is written down in `contracts` (`work.started`, `work.review_requested`,
 * `work.mergeable`, `work.merged`) and projected in the store, but until this file
 * nothing emitted those four: a Work could reach `assigned` (the briefs executor
 * writes it) and then stop, because the only other unambiguous facts the fleet
 * records are about the *PR* — `pr.opened`, `pr.checks_changed`, `pr.review_changed`,
 * `pr.merged` — and no one was translating them back onto the Work they belong to.
 * That gap is what made §15's "three Work items to `merged`" unreachable.
 *
 * So this is a listener, not a routine: the translation is a pure function of the
 * committed event and the projections, with no timer and no polling (§5.2's
 * "wake on the log" rather than "wake on the clock"). It is also deliberately
 * narrow — it *derives*, it never decides. Nothing here assigns, blocks or
 * unblocks a Work; those are the PM's, and they carry judgement this does not have.
 *
 * Five things shape the rules:
 *
 * - **A transition happens once.** Each rule reads the current Work state first and
 *   returns nothing when it disagrees, so `pr.checks_changed` and `pr.review_changed`
 *   arriving in either order still produce exactly one `work.mergeable`: the first
 *   one to see both facts green writes it, and the Work is `mergeable` by the time
 *   the second arrives.
 * - **The PR is the evidence.** `work.mergeable` is claimed only when the projection
 *   says `checks === 'passing' && review === 'approved'` — the same pair §10's
 *   `mergeBlocker` asks for — and `work.merged` only on `pr.merged`, which the gate
 *   writes after the forge said yes. Nothing here merges; the gate does (§10).
 * - **An unlinked PR is not a Work.** `pr.opened` carries an optional `workId` (the
 *   footer); without it the PR belongs to no Work and no transition is invented
 *   from its number.
 * - **`work.started` needs a session and an assignee.** It is the brief reaching the
 *   peer, which the fleet records as `message.delivered`; a resume delivers again and
 *   finds the Work already `in_progress`, so it is a no-op.
 * - **A failed append does not fail the wake.** The triggering event is already
 *   committed; throwing would report "your write failed" about someone else's write.
 *   `createWakingSink`'s `onError` is where a gap like that is already reported.
 */

import type { Clock, PeerId, SessionId, Timestamp } from '@fleet/foundation-core'
import type {
  AppendEvent,
  FleetEvent,
  Message,
  PullRequest,
  ReadModel,
  Work,
  WorkId,
} from '@fleet/foundation-contracts'
import type { CommittedListener } from './wake.ts'

export interface WorkSyncDeps {
  readonly read: Pick<ReadModel, 'work' | 'pullRequests' | 'messages'>
  readonly append: (batch: readonly AppendEvent[]) => Promise<readonly unknown[]>
  readonly clock: Clock
}

/** The states a Work can be in and still move forward; anything else is terminal or the PM's. */
const open = (work: Work): boolean =>
  work.state !== 'merged' && work.state !== 'cleaned' && work.state !== 'cancelled'

const notYetStarted = (work: Work): boolean => work.state === 'assigned'

const notYetReviewable = (work: Work): boolean =>
  work.state === 'assigned' || work.state === 'in_progress'

const notYetMergeable = (work: Work): boolean =>
  notYetReviewable(work) || work.state === 'in_review'

/** Both halves of §10's merge condition, as the projection records them. */
const green = (pr: PullRequest): boolean => pr.checks === 'passing' && pr.review === 'approved'

const prOf = (pr: PullRequest): { readonly repo: PullRequest['repo']; readonly number: number } => ({
  repo: pr.repo,
  number: pr.number,
})

const workStarted = (ts: Timestamp, work: Work, sessionId?: SessionId): AppendEvent => ({
  ts,
  type: 'work.started',
  subject: work.workId,
  actor: `peer:${String(work.assignee)}`,
  data: { workId: work.workId, peerId: work.assignee as PeerId, ...(sessionId === undefined ? {} : { sessionId }) },
})

/**
 * The transitions one committed event implies, as events to append. Pure but for
 * the reads: every rule is a function of the event and the two projections.
 */
const transitionsFor = async (
  deps: WorkSyncDeps,
  event: FleetEvent,
): Promise<readonly AppendEvent[]> => {
  const ts = deps.clock.now()

  if (event.type === 'message.delivered') {
    // The brief is the handover: `work.assigned` says who owns it, and this is the
    // moment the owner actually has it. Any other message kind is conversation.
    // The kind lives on the message row, not on the delivery event, so it is a read.
    const peerId = event.data.to
    const kind = await kindOf(deps, event.data.msgId, peerId)
    if (kind !== 'brief') return []
    const works = await deps.read.work.all()
    return works
      .filter((work) => work.assignee === peerId && notYetStarted(work))
      .map((work) => workStarted(ts, work, event.data.sessionId))
  }

  if (event.type === 'session.started') {
    // A session start with no brief delivery also means the assignee is at work —
    // a resume begins a turn on whatever it was already assigned. The delivery rule
    // above does not catch it when the brief went out before the session ended.
    const peerId = event.data.peerId
    const works = await deps.read.work.all()
    return works
      .filter((work) => work.assignee === peerId && notYetStarted(work))
      .map((work) => workStarted(ts, work, event.data.sessionId))
  }

  if (event.type === 'pr.opened') {
    const workId = event.data.workId
    if (workId === undefined) return []
    const work = await deps.read.work.get(workId as WorkId)
    // An assignee is required by the event's own schema, and a Work nobody owns has
    // nobody to have asked for the review.
    if (work === undefined || work.assignee === undefined || !notYetReviewable(work)) return []
    return [
      {
        ts,
        type: 'work.review_requested',
        subject: work.workId,
        actor: `peer:${String(work.assignee)}`,
        data: { workId: work.workId, peerId: work.assignee, pr: event.data.pr },
      },
    ]
  }

  if (event.type === 'pr.checks_changed' || event.type === 'pr.review_changed') {
    // Either order, one `work.mergeable`: see the header.
    const pr = await findPr(deps, event.data.pr)
    if (pr === undefined || pr.workId === undefined || !green(pr)) return []
    const work = await deps.read.work.get(pr.workId as WorkId)
    if (work === undefined || !notYetMergeable(work)) return []
    return [
      {
        ts,
        type: 'work.mergeable',
        subject: work.workId,
        actor: 'scheduler',
        data: { workId: work.workId, pr: prOf(pr), headSha: pr.headSha },
      },
    ]
  }

  if (event.type === 'pr.merged') {
    const pr = await findPr(deps, event.data.pr)
    if (pr === undefined || pr.workId === undefined) return []
    const work = await deps.read.work.get(pr.workId as WorkId)
    if (work === undefined || !open(work) || work.state === 'merged') return []
    return [
      {
        ts,
        type: 'work.merged',
        subject: work.workId,
        actor: 'scheduler',
        data: {
          workId: work.workId,
          pr: prOf(pr),
          headSha: pr.headSha,
          ...(event.data.mergeSha === undefined ? {} : { mergeSha: event.data.mergeSha }),
        },
      },
    ]
  }

  return []
}

/** A delivered message's kind, from the row the Mailbox already wrote (§7). */
const kindOf = async (
  deps: WorkSyncDeps,
  msgId: Message['msgId'],
  to: PeerId,
): Promise<Message['kind'] | undefined> => {
  const messages = await deps.read.messages.forPeer(to)
  return messages.find((message) => message.msgId === msgId)?.kind
}

/** The PR row the projection already holds — the read model has no get by ref. */
const findPr = async (
  deps: WorkSyncDeps,
  ref: { readonly repo: PullRequest['repo']; readonly number: number },
): Promise<PullRequest | undefined> => {
  const all = await deps.read.pullRequests.all()
  return all.find((pr) => pr.repo === ref.repo && pr.number === ref.number)
}

export const syncWork = (deps: WorkSyncDeps): CommittedListener => async (event) => {
  const batch = await transitionsFor(deps, event)
  if (batch.length === 0) return
  await deps.append(batch)
}
