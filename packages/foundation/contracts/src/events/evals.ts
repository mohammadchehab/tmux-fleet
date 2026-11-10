/**
 * The three events one eval run writes (architecture §17).
 *
 * Evals are the one part of the fleet that is not deterministic, so their
 * results are facts the log keeps rather than numbers a report recomputes:
 * `eval.run_started` opens a run, `eval.run_finished` closes it with its
 * aggregates, and `eval.case_scored` records one attempt at one case. The
 * adapter in `packages/evals` is the only producer — the runtime never appends
 * these, and nothing in `runtime` or `orchestration` reads them.
 *
 * A run's subject is its own `runId`: a case row is part of the run, not a
 * separate entity, and the id is what `fleet evals compare <runA> <runB>` takes.
 *
 * `eval.run_finished` repeats the run's identity (`suite`, `sha`, `provider`,
 * `model`, `cases`) instead of relying on `eval.run_started` having been read:
 * §17's first slice records a finished run without a start, and a reader that
 * needs the identity should not have to walk back through the log for it.
 */

import {
  boolean,
  count,
  event,
  number,
  object,
  oneOf,
  optional,
  positiveInt,
  refine,
  string,
  type Schema,
} from '@fleet/foundation-core'
import { evalRunId, sha } from '@fleet/foundation-core'
import { providerId } from '../provider.ts'

/** The five suites §17 declares. `model-choice` compares runs; it never gates. */
export const evalSuites = ['judge', 'briefs', 'purge-resume', 'security-triage', 'model-choice'] as const
export type EvalSuite = (typeof evalSuites)[number]

export const evalSuite = (): Schema<EvalSuite> => oneOf(evalSuites)

/**
 * A case id is the file stem of `tests/evals/cases/<suite>/<id>.json`, so it is
 * a slug a human writes, not an opaque minted id.
 */
export const evalCaseId = (): Schema<string> =>
  string({ pattern: /^[a-z0-9][a-z0-9_-]*$/, minLength: 1, maxLength: 80 })

/** The model under test. Not `judge:<model>`: the actor is who appended, this is what ran. */
const evalModel = (): Schema<string> => string({ minLength: 1, maxLength: 80 })

/** A run opens: the suite, the revision, the model, and how many cases it will score. */
export const evalRunStarted = event(
  'eval.run_started',
  object({
    runId: evalRunId(),
    suite: evalSuite(),
    sha: sha(),
    provider: providerId(),
    model: evalModel(),
    /** How many cases the run intends to score, so a short run is visible as short. */
    cases: positiveInt(),
  }),
)

/**
 * A run closes with its aggregates. `costUsd` is absent when the provider does
 * not report usage cost (§17: "only when `capabilities.usageCost`, else n/a"),
 * never recorded as `0`.
 */
export const evalRunFinished = event(
  'eval.run_finished',
  refine(
    object({
      runId: evalRunId(),
      suite: evalSuite(),
      sha: sha(),
      provider: providerId(),
      model: evalModel(),
      cases: positiveInt(),
      passed: count(),
      tokensIn: count(),
      tokensOut: count(),
      costUsd: optional(number({ min: 0 })),
      latencyMs: count(),
    }),
    (value) => value.passed <= value.cases,
    'a run that passed no more cases than it scored',
  ),
)

/**
 * One attempt at one case. A case is run N=3 times because the model is not
 * deterministic (§17), so `attempt` is 1-based and the attempt, not the case,
 * is the unit the log records.
 *
 * `score` is `0..1` for every suite: exact match scores `1` or `0`, a rubric
 * scores the share of its yes/no items that passed. `detail` is the reason the
 * adapter kept — the mismatched field, or the grader's justification — because
 * a bare number cannot be spot-checked by a human.
 */
export const evalCaseScored = event(
  'eval.case_scored',
  object({
    runId: evalRunId(),
    caseId: evalCaseId(),
    attempt: positiveInt(),
    pass: boolean(),
    score: number({ min: 0, max: 1 }),
    detail: string({ minLength: 1, maxLength: 2000 }),
  }),
)
