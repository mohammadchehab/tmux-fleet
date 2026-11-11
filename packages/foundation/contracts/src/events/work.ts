/**
 * Work items through the state machine (architecture §5.1, §5.2, §12). One
 * event per transition, subject `workId`; the state is a projection, never a
 * column a caller writes.
 */

import { array, event, object, optional, string, text } from '@fleet/foundation-core'
import {
  briefId,
  contractId,
  peerId,
  positiveInt,
  sessionId,
  sha,
  workId,
  worktreeId,
} from '@fleet/foundation-core'
import { blockReason, workNotePhase } from '../work-state.ts'
import { externalRef, line, pullRequestRef } from '../shapes.ts'

/** A Work exists. `dependsOn` holds the ids of Work or Contract it must wait for (§5.2, §12). */
export const workProposed = event(
  'work.proposed',
  object({
    workId: workId(),
    title: line(),
    /** Which role should take it; the PM's `assign` rule matches on this (§5.2). */
    role: optional(string({ minLength: 1, maxLength: 80 })),
    body: optional(text(20_000)),
    contractId: optional(contractId()),
    dependsOn: array(workId()),
    external: optional(externalRef()),
  }),
)

/** The Work needs a shared contract before any peer may start (§12). */
export const workContractNeeded = event(
  'work.contract_needed',
  object({ workId: workId(), contractId: contractId() }),
)

/** The Work is startable: its dependencies and its contract are satisfied. */
export const workReady = event(
  'work.ready',
  object({ workId: workId(), reason: optional(text(500)) }),
)

/** The PM wrote a brief and handed the Work over. The brief is its own event (`brief.published`). */
export const workAssigned = event(
  'work.assigned',
  object({ workId: workId(), peerId: peerId(), briefId: briefId(), briefVersion: positiveInt() }),
)

/** The peer actually began: a session turn started on it. */
export const workStarted = event(
  'work.started',
  object({ workId: workId(), peerId: peerId(), sessionId: optional(sessionId()) }),
)

/**
 * A peer's structured progress note (§5.1): what it is doing, phrased in one of
 * four phases rather than as free text.
 *
 * The phase is what earns the event its place. A note is mirrored to the board
 * a human reads (`Tracker.comment`), and a board only tells you something when
 * every comment has the same shape — `plan` / `implement` / `mr` — so the
 * closed list in `work-state.ts` is the contract, not a suggestion.
 *
 * `blocked` is the one phase with a consequence: the PM raises a `Decision` for
 * it, because the alternative is a peer waiting on a question nobody was asked.
 * It is a note, not a state: `work.blocked` is the transition the PM makes, and
 * a peer saying it is stuck is information, not the PM's own verdict.
 */
export const workNoted = event(
  'work.noted',
  object({
    workId: workId(),
    /** Who said it. Every note has an author; an unattributed one cannot be acted on. */
    peerId: peerId(),
    phase: workNotePhase(),
    body: text(2000),
  }),
)

/** The peer says the work is ready for review (a PR exists or was updated). */
export const workReviewRequested = event(
  'work.review_requested',
  object({ workId: workId(), peerId: peerId(), pr: optional(pullRequestRef()) }),
)

/** Checks are green on the current head SHA and the review is satisfied (§10). */
export const workMergeable = event(
  'work.mergeable',
  object({ workId: workId(), pr: pullRequestRef(), headSha: sha() }),
)

/** The gate merged it. The PR gate merges; the PM never does (§5.2, §10). */
export const workMerged = event(
  'work.merged',
  object({ workId: workId(), pr: pullRequestRef(), headSha: sha(), mergeSha: optional(sha()) }),
)

/** The worktree was removed after the merge, cleanly (§9); the Work is finished. */
export const workCleaned = event(
  'work.cleaned',
  object({ workId: workId(), worktreeId: optional(worktreeId()) }),
)

/** Something outside the PM stops progress; `blockReason` decides who can unblock it (§5.2). */
export const workBlocked = event(
  'work.blocked',
  object({ workId: workId(), reason: text(1000), blockedOn: blockReason() }),
)

export const workCancelled = event(
  'work.cancelled',
  object({ workId: workId(), reason: text(1000) }),
)
