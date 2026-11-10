/**
 * `matchHeadSha` — §10's pin, as a pure function over two observations.
 *
 * The gate refuses to merge a PR whose head has moved since the PM's action was
 * decided (`mergeRefusal`'s `head_moved`, `preconditions.ts`), and it re-reads
 * the PR before the one call that cannot be undone. This module is the other
 * half of the same rule, at the boundary where observations are *made*: a
 * checks verdict is only about the sha it graded, so writing that verdict onto
 * a `pr.checks_changed` (or comparing it to a recorded PR) is allowed only when
 * the sha it was graded at is the sha the PR is at now. Two calls to `gh`, a
 * force-push between them, and a verdict recorded against the wrong commit is
 * how a red PR gets merged green.
 *
 * Keeping it here rather than inside `checks()` is deliberate: the observation
 * and the decision about it are separate, so the decision is testable without a
 * fake `gh` and re-usable by whatever writes the event (a routine, a babysit
 * loop, the daemon).
 */

import type { Sha } from '@fleet/foundation-core'

/** The one field the rule reads. A `PullRequest` and a `GradedChecks` both have it, structurally. */
export interface HeadSha {
  readonly headSha: Sha
}

/** May an observation graded at `observed` be recorded against `recorded`? True only for the same commit. */
export const matchHeadSha = (observed: HeadSha, recorded: HeadSha): boolean => observed.headSha === recorded.headSha

const short = (sha: Sha): string => String(sha).slice(0, 10)

/**
 * The same question, with the sentence a `routine.finished` record or a log line
 * can carry. `undefined` means the observation stands, so a caller writes
 * nothing and appends the fact.
 */
export const headMismatch = (
  observed: HeadSha,
  recorded: HeadSha & { readonly repo?: string; readonly number?: number },
): string | undefined => {
  if (matchHeadSha(observed, recorded)) return undefined
  const where = recorded.repo === undefined ? 'the pull request' : `${recorded.repo}#${String(recorded.number ?? '?')}`
  return `checks were graded at ${short(observed.headSha)} but ${where} is at ${short(recorded.headSha)}; the observation does not describe it (§10)`
}
