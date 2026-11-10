/**
 * `EvalRun` and `EvalCase`: the two read models over the log's eval events
 * (architecture §17).
 *
 * They exist so a baseline comparison and the standup are one read each and
 * never a walk through the raw events. Neither is part of `FleetState`: the PM
 * does not route on an eval result, so `decide()` is not handed them.
 */

import { boolean, count, number, objectAs, oneOf, optional, positiveInt, refine, string, text, timestamp, type Schema } from '@fleet/foundation-core'
import { evalRunId, sha } from '@fleet/foundation-core'
import type { EvalRunId, Sha } from '@fleet/foundation-core'
import { providerId } from '../provider.ts'
import { evalCaseId, evalSuites, type EvalSuite } from '../events/evals.ts'

/** `running` until `eval.run_finished` lands; there is no `cancelled` — a run that dies stays visible as running. */
export const evalRunStates = ['running', 'finished'] as const
export type EvalRunState = (typeof evalRunStates)[number]

export interface EvalRun {
  readonly runId: EvalRunId
  readonly suite: EvalSuite
  /** The revision whose Judge prompts, cases and configs the run measured. */
  readonly sha: Sha
  readonly provider: string
  readonly model: string
  /** How many cases the run set out to score. */
  readonly cases: number
  readonly state: EvalRunState
  /** Set by `eval.run_finished`: how many of `cases` passed. */
  readonly passed?: number
  readonly tokensIn?: number
  readonly tokensOut?: number
  /** Absent when the provider reports no usage cost — the report shows n/a, not `0.00` (§17). */
  readonly costUsd?: number
  readonly latencyMs?: number
  readonly startedAt: string
  readonly finishedAt?: string
}

export const evalRun = (): Schema<EvalRun> =>
  objectAs<EvalRun>()({
    runId: evalRunId(),
    suite: oneOf(evalSuites),
    sha: sha(),
    provider: providerId(),
    model: string({ minLength: 1, maxLength: 80 }),
    cases: positiveInt(),
    state: oneOf(evalRunStates),
    passed: optional(count()),
    tokensIn: optional(count()),
    tokensOut: optional(count()),
    costUsd: optional(number({ min: 0 })),
    latencyMs: optional(count()),
    startedAt: timestamp(),
    finishedAt: optional(timestamp()),
  })

/**
 * One case in one run, keyed `(runId, caseId)`.
 *
 * A case is attempted N=3 times (§17), so the row keeps the tally — `passes`
 * of `attempts` is the pass rate the report shows — and beside it the *last*
 * attempt's `pass`, `score` and `detail`, which is what a human spot-check
 * reads. Keeping the last attempt rather than the best one is deliberate: a
 * case that passed twice and failed once should look like it, not like a pass.
 */
export interface EvalCase {
  readonly runId: EvalRunId
  readonly caseId: string
  readonly attempts: number
  readonly passes: number
  readonly pass: boolean
  readonly score: number
  readonly detail: string
  readonly updatedAt: string
}

export const evalCase = (): Schema<EvalCase> =>
  // A case cannot pass more attempts than it had. The store's tally already keeps
  // that true, but the pass rate is what §17 gates on, so the row itself refuses
  // to be a number no run could have produced.
  refine(
    objectAs<EvalCase>()({
      runId: evalRunId(),
      caseId: evalCaseId(),
      attempts: positiveInt(),
      passes: count(),
      pass: boolean(),
      score: number({ min: 0, max: 1 }),
      detail: text(2000),
      updatedAt: timestamp(),
    }),
    (row) => row.passes <= row.attempts,
    'a case that passed more attempts than it had',
  )
