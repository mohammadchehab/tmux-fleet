/**
 * `fleet evals run judge`: the run itself, and the verdict it exits with (§17).
 *
 * The promptfoo config answers one case per command and prints its own report; this
 * is the same suite driven for a gate — the same case files, the same
 * `createJudgeRunner` transport, the same canonical rendering and the same exact
 * match — with three differences that a gate needs and an interactive run does not:
 *
 * - **The result is JSON on stdout**, so the CLI can print it through
 *   `evals-report.ts` without importing anything of this package (§1.1: nothing
 *   outside `evals` imports `evals`, and the CLI is not an exception).
 * - **Every case is scored, and the shortfall is a decision.** A case that cannot
 *   answer is a failed attempt, not a skipped one: a run that dropped its hard cases
 *   would report a better rate.
 * - **The exit code is the comparison against a stored baseline**, not against a
 *   pass-rate floor. `RATE_FLOOR` is a display rule (fewer than twenty cases and
 *   there is no percentage to print); a gate on it would fail every run of a
 *   ten-case suite forever.
 *
 * The events are built by `eventsFromReport`, not here: the fold from attempts to
 * `passed` (a case passes only if every attempt did), the cost rule and the detail
 * line are the adapter's, and a second copy of them would be a second answer to
 * "what did this run score".
 */

import { EVAL_ATTEMPTS, type EvalSuite } from '@fleet/foundation-contracts'
import { newEvalRunId, type EvalRunId } from '@fleet/foundation-core'
import { eventsFromReport, type Report, type ReportEvents, type ReportResult } from '@fleet/evals-adapter'

import type { JudgeCase } from './case.ts'
import { renderDecision } from './decision.ts'
import type { JudgeRun } from './judge-provider.ts'

/** One case, one attempt. `attempt` is 1-based because a `repeatIndex` of 0 is a row and an attempt of 0 is not. */
export interface AttemptRecord {
  readonly caseId: string
  readonly attempt: number
  readonly pass: boolean
  readonly score: number
  readonly detail: string
  readonly latencyMs: number
  readonly retries: number
  readonly tokens: { readonly prompt: number; readonly completion: number }
  readonly cost: number
}

/** One case's attempts, with the two numbers a baseline and the report both need. */
export interface CaseResult {
  readonly caseId: string
  readonly attempts: readonly AttemptRecord[]
  readonly passes: number
  /** `passes / attempts`: the baseline's unit, because a case is scored N=3 times. */
  readonly rate: number
  /** Every attempt passed — the rule `eval.run_finished`'s `passed <= cases` encodes. */
  readonly passed: boolean
}

/** What `fleet evals run` prints. Structurally the CLI's `EvalRunReport`; named here so the shapes stay in step. */
export interface RunReport {
  readonly suite: EvalSuite
  readonly provider: string
  readonly model: string
  readonly sha: string
  readonly cases: number
  readonly passed: number
  readonly tokens: { readonly input: number; readonly output: number }
  /** Per-case latency, one number per case: the mean of its attempts. */
  readonly latencyMs: readonly number[]
  readonly retries: number
  readonly costUsd?: number
}

export interface SuiteRun {
  readonly runId: EvalRunId
  readonly report: RunReport
  readonly results: readonly CaseResult[]
  /** The start, the N attempts of every case, and the total — exactly what the daemon appends. */
  readonly events: ReportEvents
}

export interface SuiteRunInput {
  readonly cases: readonly JudgeCase[]
  /** The model runner: the real Judge in production, a fake in a test — no test makes a model call. */
  readonly run: (c: JudgeCase) => Promise<JudgeRun>
  readonly provider: string
  readonly model: string
  readonly sha: string
  /** The instant every event carries, passed in so a test's events are the same on every run. */
  readonly now: string
  /** §17's N=3 by default, from the contract so a run cannot quietly become N=1. */
  readonly attempts?: number
  readonly runId?: EvalRunId
}

/**
 * The one attempt's outcome. `pass` is exact equality against the case's canonical
 * rendering, which is the assertion the promptfoo config compiles to a one-line
 * `javascript` assert — the same rule, spelled in TypeScript because this path has no
 * promptfoo to hand the string to.
 */
const attemptOf = (c: JudgeCase, run: JudgeRun): Omit<AttemptRecord, 'caseId' | 'attempt'> => {
  const expectedText = renderDecision(c.expected)
  const pass = run.output !== undefined && run.output === expectedText
  const detail = pass
    ? `answered ${expectedText}`
    : run.error !== undefined
      ? run.error
      : run.output === undefined
        ? 'the provider returned no answer'
        : `expected ${expectedText} but the model answered ${run.output}`
  return {
    pass,
    score: pass ? 1 : 0,
    detail: detail.slice(0, 2000),
    latencyMs: Math.max(0, Math.round(run.durationMs)),
    retries: run.retries ?? 0,
    // The Judge path does not hand usage back today, so a run records none rather
    // than a number it guessed. `costUsd` is omitted for the same reason (§17).
    tokens: { prompt: 0, completion: 0 },
    cost: 0,
  }
}

/** Every attempt of every case, in case order — the order the report and the events both read. */
const attemptAll = async (input: SuiteRunInput): Promise<readonly AttemptRecord[]> => {
  const attempts = input.attempts ?? EVAL_ATTEMPTS
  const records: AttemptRecord[] = []
  for (const c of input.cases) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      records.push({ caseId: c.id, attempt, ...attemptOf(c, await input.run(c)) })
    }
  }
  return records
}

const foldCases = (records: readonly AttemptRecord[]): readonly CaseResult[] => {
  const byCase = new Map<string, AttemptRecord[]>()
  for (const record of records) {
    const seen = byCase.get(record.caseId)
    if (seen === undefined) byCase.set(record.caseId, [record])
    else seen.push(record)
  }
  return [...byCase].map(([caseId, attempts]) => {
    const passes = attempts.filter((a) => a.pass).length
    return { caseId, attempts, passes, rate: passes / attempts.length, passed: passes === attempts.length }
  })
}

/** The rows `eventsFromReport` reads: one per attempt, carrying the case's expectation and the answer. */
const rowsOf = (
  records: readonly AttemptRecord[],
  cases: readonly JudgeCase[],
  providerId: string,
): readonly ReportResult[] => {
  const byId = new Map(cases.map((c) => [c.id, c]))
  return records.map((record, index) => {
    const c = byId.get(record.caseId)
    const expectedText = c === undefined ? undefined : renderDecision(c.expected)
    return {
      // The case's index in the suite, which is what promptfoo's `testIdx` names.
      testIdx: cases.findIndex((one) => one.id === record.caseId),
      // promptfoo counts repeats from 0; the event's `attempt` is 1-based and adds one.
      repeatIndex: record.attempt - 1,
      providerId,
      success: record.pass,
      score: record.score,
      latencyMs: record.latencyMs,
      caseId: record.caseId,
      ...(expectedText === undefined ? {} : { expectedText }),
      ...(record.pass && expectedText !== undefined ? { output: expectedText } : { reason: record.detail }),
      cost: record.cost,
      tokens: { ...record.tokens, cached: 0 },
      ...(c === undefined ? {} : { suite: c.suite }),
    }
  })
}

const reportOf = (
  results: readonly CaseResult[],
  input: SuiteRunInput,
  records: readonly AttemptRecord[],
): RunReport => {
  const tokensIn = records.reduce((sum, r) => sum + r.tokens.prompt, 0)
  const tokensOut = records.reduce((sum, r) => sum + r.tokens.completion, 0)
  const cost = records.reduce((sum, r) => sum + r.cost, 0)
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : Math.round(values.reduce((sum, one) => sum + one, 0) / values.length)
  return {
    suite: 'judge',
    provider: input.provider,
    model: input.model,
    sha: input.sha,
    cases: results.length,
    passed: results.filter((r) => r.passed).length,
    tokens: { input: tokensIn, output: tokensOut },
    latencyMs: results.map((r) => mean(r.attempts.map((a) => a.latencyMs))),
    retries: records.reduce((sum, r) => sum + r.retries, 0),
    ...(cost > 0 ? { costUsd: cost } : {}),
  }
}

/** Run every case N times and return the report, the per-case tallies, and the events to append. */
export const runSuite = async (input: SuiteRunInput): Promise<SuiteRun> => {
  if (input.cases.length === 0) throw new Error('a suite with no cases scores nothing')
  const records = await attemptAll(input)
  const results = foldCases(records)
  const providerId = `fleet-judge:${input.provider}:${input.model}`
  const runId = input.runId ?? newEvalRunId()
  const rows = rowsOf(records, input.cases, providerId)
  const report: Report = {
    // promptfoo's own `eval-…` id has no counterpart here: this path is driven
    // directly, so the run's id is the fleet's and the two are the same id.
    evalId: runId,
    results: rows,
    stats: {
      successes: rows.filter((r) => r.success).length,
      failures: rows.filter((r) => !r.success).length,
      errors: rows.filter((r) => r.output === undefined).length,
      durationMs: records.reduce((sum, r) => sum + r.latencyMs, 0),
      tokens: {
        prompt: records.reduce((sum, r) => sum + r.tokens.prompt, 0),
        completion: records.reduce((sum, r) => sum + r.tokens.completion, 0),
        cached: 0,
      },
    },
  }
  const events = eventsFromReport(report, { sha: input.sha, now: input.now, runId })
  return { runId, report: reportOf(results, input, records), results, events }
}

// ------------------------------------------------------------------ the baseline

/**
 * How far a case's pass rate may fall before the run fails. A third, because §17 runs
 * a case three times: a case that always passed may flake once and still be the same
 * case, and a case that fell from three to one is a different model answering.
 */
export const DEFAULT_TOLERANCE = 1 / 3

/** One case in the baseline file: the numerator and the denominator, not a rounded rate. */
export interface BaselineCase {
  readonly attempts: number
  readonly passes: number
}

export interface Baseline {
  readonly suite: string
  readonly sha: string
  readonly savedAt: string
  /** The tolerance the run was saved with; a flaky suite can be loosened by editing this. */
  readonly tolerance: number
  readonly cases: Readonly<Record<string, BaselineCase>>
}

/** A baseline file that is not one: refused by name, because the fix is to re-save it. */
export class BaselineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BaselineError'
  }
}

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BaselineError(`${path}: expected an object`)
  }
  return value as Record<string, unknown>
}

const count = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BaselineError(`${path}: expected a whole number, got ${JSON.stringify(value)}`)
  }
  return value
}

const text = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value === '') throw new BaselineError(`${path}: expected a non-empty string`)
  return value
}

/**
 * Decode a baseline file. Hand-checked for the same reason the adapter hand-checks a
 * promptfoo report: the file is edited by people, and a baseline that half-parses
 * would compare a run against a number nobody wrote.
 */
export const readBaseline = (body: string): Baseline => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new BaselineError(`not JSON: ${(error as Error).message}`)
  }
  const root = record(parsed, '<baseline>')
  const cases = record(root['cases'], 'cases')
  const decoded: Record<string, BaselineCase> = {}
  for (const [caseId, entry] of Object.entries(cases)) {
    const row = record(entry, `cases.${caseId}`)
    const attempts = count(row['attempts'], `cases.${caseId}.attempts`)
    if (attempts === 0) throw new BaselineError(`cases.${caseId}.attempts: a case with no attempts has no rate`)
    const passes = count(row['passes'], `cases.${caseId}.passes`)
    if (passes > attempts) throw new BaselineError(`cases.${caseId}: ${String(passes)} passes of ${String(attempts)} attempts`)
    decoded[caseId] = { attempts, passes }
  }
  if (Object.keys(decoded).length === 0) throw new BaselineError('cases: a baseline with no cases compares nothing')
  const tolerance = root['tolerance']
  return {
    suite: text(root['suite'], 'suite'),
    sha: text(root['sha'], 'sha'),
    savedAt: text(root['savedAt'], 'savedAt'),
    tolerance: typeof tolerance === 'number' && Number.isFinite(tolerance) ? tolerance : DEFAULT_TOLERANCE,
    cases: decoded,
  }
}

/** The baseline a run writes: what this run scored, per case, and how tolerant a comparison of it should be. */
export const baselineFrom = (run: SuiteRun, savedAt: string, tolerance = DEFAULT_TOLERANCE): Baseline => ({
  suite: run.report.suite,
  sha: run.report.sha,
  savedAt,
  tolerance,
  cases: Object.fromEntries(
    run.results.map((r) => [r.caseId, { attempts: r.attempts.length, passes: r.passes }]),
  ),
})

/** `passes` must not fall below `baselinePasses - tolerance × attempts`; the epsilon keeps `2/3` off the line. */
const EPSILON = 1e-9

export interface Regression {
  readonly caseId: string
  readonly passes: number
  readonly attempts: number
  readonly baselinePasses: number
  readonly baselineAttempts: number
}

export type Gate =
  /** No baseline file yet: a run says so and passes, because it has nothing to be worse than. */
  | { readonly kind: 'no-baseline'; readonly exitCode: 0 }
  /** `--save-baseline`: this run is the baseline now. */
  | { readonly kind: 'saved'; readonly exitCode: 0 }
  | { readonly kind: 'pass'; readonly exitCode: 0 }
  | { readonly kind: 'regressed'; readonly exitCode: 1; readonly regressions: readonly Regression[] }

/**
 * Compare a run with its baseline, case by case.
 *
 * A case in the run and not in the baseline is not a regression: it is new, and nothing
 * says what it used to do. A case in the baseline and not in the run is a case the suite
 * stopped scoring, which is the run's own business to notice — the gate compares the
 * cases it has.
 */
export const gateFor = (run: SuiteRun, baseline: Baseline): Gate => {
  const regressions: Regression[] = []
  for (const result of run.results) {
    const expected = baseline.cases[result.caseId]
    if (expected === undefined) continue
    const allowed = expected.passes - baseline.tolerance * expected.attempts
    if (result.passes + EPSILON < allowed) {
      regressions.push({
        caseId: result.caseId,
        passes: result.passes,
        attempts: result.attempts.length,
        baselinePasses: expected.passes,
        baselineAttempts: expected.attempts,
      })
    }
  }
  return regressions.length === 0 ? { kind: 'pass', exitCode: 0 } : { kind: 'regressed', exitCode: 1, regressions }
}

/** The JSON `fleet evals run` reads back. One object on stdout; everything else is on stderr. */
export interface RunOutput {
  readonly runId: string
  readonly report: RunReport
  readonly gate: Gate
  /** Where the baseline went, when `--save-baseline` wrote one. */
  readonly baselinePath?: string
  /**
   * The `eval.*` rows this run is worth, handed over rather than appended: the
   * store has one writer and it is the daemon, so the CLI sends these through
   * `events.append` and this process stays read-only (§17).
   */
  readonly events: ReportEvents
}

/** The baseline file, relative to the repo root. One suite, one file named for it. */
export const BASELINE_PATH = 'tests/evals/baselines/judge.json'

export interface RunOptions extends SuiteRunInput {
  /** The baseline file's text, or `undefined` when there is no file yet. */
  readonly baseline?: string
  /** Write this run as the new baseline instead of comparing against one. */
  readonly saveBaseline?: boolean
  readonly tolerance?: number
}

/** What `main.ts` prints and, when asked, writes. */
export interface Judged {
  readonly output: RunOutput
  /** The baseline to persist, already computed: the binary only decides where the file goes. */
  readonly baseline?: Baseline
}

/**
 * The run, the comparison, and what to print. Kept separate from the binary so the
 * whole of it — including the gate — is a test with a fake runner and a baseline
 * string, and the only thing `main.ts` adds is the filesystem and the clock.
 */
export const runJudge = async (options: RunOptions): Promise<Judged> => {
  const run = await runSuite(options)
  const body = { runId: run.runId, report: run.report, events: run.events }
  if (options.saveBaseline === true) {
    return {
      output: { ...body, gate: { kind: 'saved', exitCode: 0 }, baselinePath: BASELINE_PATH },
      baseline: baselineFrom(run, options.now, options.tolerance ?? DEFAULT_TOLERANCE),
    }
  }
  if (options.baseline === undefined) {
    return { output: { ...body, gate: { kind: 'no-baseline', exitCode: 0 } } }
  }
  const baseline = readBaseline(options.baseline)
  if (baseline.suite !== run.report.suite) {
    throw new BaselineError(
      `the baseline is for the ${baseline.suite} suite and this run is ${run.report.suite}; a comparison across suites is not one`,
    )
  }
  return { output: { ...body, gate: gateFor(run, baseline) } }
}
