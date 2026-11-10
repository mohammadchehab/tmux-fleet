/**
 * §10's preconditions, as a pure function.
 *
 * The gate's rules are the part of it that must be readable and reviewable on
 * their own: which PR may be merged, and on what evidence. They are separated
 * from the calls that carry them out so a test can ask "would this merge?" for
 * every state a PR can be in without a fake git or a fake `gh` — and so a rule
 * cannot be quietly reordered by whoever edits the sequence of port calls.
 *
 * The refusals are a closed list rather than free text because each one is a
 * fact the PM and the notification layer may want to act on: `checks_not_green`
 * becomes a nudge, `stack_parent_unmerged` means the parent is the thing to
 * merge, and `head_moved` means the PM's action was decided on a sha that is no
 * longer the head (§5.4 — the inputs moved, not the rule).
 */

import type { ChecksState, PullRequest, ReviewState } from '@fleet/foundation-contracts'
import type { MergeAction } from '@fleet/foundation-contracts'

/** Why the gate refused to merge. Ordered as the checks run, so the first one is the most specific. */
export const mergeRefusals = [
  'missing',
  'already_merged',
  'head_moved',
  'checks_not_green',
  'review_not_clean',
  'stack_parent_unmerged',
] as const
export type MergeRefusal = (typeof mergeRefusals)[number]

/** What the gate could read when it was asked. `parent` is absent when the PR has no stack parent. */
export interface MergeFacts {
  /** The PR as the port reports it now, or `undefined` when the port does not have it. */
  readonly pr?: PullRequest
  /** The stack parent's current state, when `pr.stackParent` names one. */
  readonly parent?: PullRequest
}

/** The review state §10 calls clean. A `pending` review is not a refusal to hide — the gate refuses and says so. */
const cleanReview: ReviewState = 'approved'
/** The only checks state that may merge. `pending` is refused, because the sha may still move (§10). */
const greenChecks: ChecksState = 'passing'

/**
 * §10 in one place. The order matters only for which reason is reported first;
 * every refusal is a reason not to merge on its own.
 */
export const mergeRefusal = (action: MergeAction, facts: MergeFacts): MergeRefusal | undefined => {
  const { pr } = facts
  if (pr === undefined) return 'missing'
  if (pr.merged) return 'already_merged'
  // Pinned to the sha the PM saw: the gate merges the head it was told about or nothing (§10).
  if (pr.headSha !== action.headSha) return 'head_moved'
  if (pr.checks !== greenChecks) return 'checks_not_green'
  if (pr.review !== cleanReview) return 'review_not_clean'
  // Stacks are first-class: a PR whose parent is still open is not mergeable, and the parent is (§10).
  if (pr.stackParent !== undefined && facts.parent?.merged !== true) return 'stack_parent_unmerged'
  return undefined
}

const short = (sha: string): string => sha.slice(0, 10)

/** One line a `routine.finished` record and a notification can both carry. */
export const describeMergeRefusal = (refusal: MergeRefusal, action: MergeAction, facts: MergeFacts): string => {
  const where = `${String(action.pr.repo)}#${String(action.pr.number)}`
  switch (refusal) {
    case 'missing':
      return `${where} is not a pull request the gate can read`
    case 'already_merged':
      return `${where} is already merged`
    case 'head_moved':
      return `${where} is at ${short(facts.pr?.headSha ?? '')}, not the ${short(String(action.headSha))} the checks were green on`
    case 'checks_not_green':
      return `${where} has ${String(facts.pr?.checks ?? 'unknown')} checks, not passing${failingLine(facts.pr)}`
    case 'review_not_clean':
      return `${where} is '${String(facts.pr?.review ?? 'unknown')}', not approved`
    case 'stack_parent_unmerged': {
      const parent = facts.pr?.stackParent
      const name = parent === undefined ? 'its stack parent' : `${String(parent.repo)}#${String(parent.number)}`
      return `${where} still sits on ${name}; merge the parent and retarget the dependent first`
    }
  }
}

const failingLine = (pr: PullRequest | undefined): string =>
  pr === undefined || pr.failingChecks.length === 0 ? '' : `: ${pr.failingChecks.join(', ')}`
