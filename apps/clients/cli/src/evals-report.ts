/**
 * What `fleet evals run` prints (§17).
 *
 * The scoring rule that shapes this file: **a pass rate is shown with its case
 * count, and never as a percentage on fewer than twenty cases.** A suite of ten
 * can only produce 0%, 10%, … 100%, so "80%" reads like a measurement when it
 * is one case, and a run-to-run wobble of a single case looks like a regression.
 * Under the floor the count is printed and the rate is not, and the line says
 * which — a missing percentage that looks like an oversight is worse than none.
 *
 * Everything else is recorded, not judged: tokens in and out, latency, retries,
 * and cost only when the provider reports it (§17). None of it is a comparison;
 * `fleet evals compare` is where two runs are put side by side.
 */

/** Below this many cases there is no pass rate, only a count (§17). */
export const RATE_FLOOR = 20

/**
 * One suite run, as the runner hands it over. `passed` counts cases that passed,
 * not runs: a case run three times passes only if all three did, and the runner
 * decides that (§17's N=3) — the report only divides.
 */
export interface EvalRunReport {
  readonly suite: string
  readonly provider: string
  readonly model: string
  readonly sha: string
  readonly cases: number
  readonly passed: number
  readonly tokens: { readonly input: number; readonly output: number }
  /** Per-case latency, in milliseconds: one number per case run. */
  readonly latencyMs: readonly number[]
  readonly retries: number
  /** Absent when the provider does not report cost; printed as `n/a`, never as 0. */
  readonly costUsd?: number
}

/**
 * The pass rate, or `undefined` under the floor. Returning a number here and
 * rounding at the edge keeps every caller from inventing its own threshold.
 */
export const passRate = (report: EvalRunReport): number | undefined =>
  report.cases < RATE_FLOOR ? undefined : report.passed / report.cases

const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`

const duration = (ms: number): string => (ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`)

/** Mean and worst; a mean alone hides the case that hung. */
const latency = (samples: readonly number[]): string => {
  if (samples.length === 0) return '-'
  const mean = samples.reduce((sum, one) => sum + one, 0) / samples.length
  return `${duration(mean)} mean, ${duration(Math.max(...samples))} worst`
}

export const formatEvalRun = (report: EvalRunReport): string => {
  const rate = passRate(report)
  const counted = `${String(report.passed)} of ${String(report.cases)} cases passed`

  // The count first, always: it is the fact, and the rate is the summary of it.
  const verdict = rate === undefined ? counted : `${counted} (${percent(rate)})`
  const floor =
    rate === undefined
      ? [`no pass rate under ${String(RATE_FLOOR)} cases: ${String(report.cases)} graded`]
      : []

  return [
    `${report.suite}: ${report.provider}/${report.model} at ${report.sha.slice(0, 7)}`,
    `  ${verdict}`,
    ...floor.map((line) => `  ${line}`),
    `  tokens    in ${String(report.tokens.input)} · out ${String(report.tokens.output)}`,
    `  latency   ${latency(report.latencyMs)}`,
    `  retries   ${String(report.retries)}`,
    `  cost      ${report.costUsd === undefined ? 'n/a (the provider does not report it)' : `$${report.costUsd.toFixed(4)}`}`,
  ].join('\n')
}
