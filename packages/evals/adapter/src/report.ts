/**
 * The reader for promptfoo's JSON report (§17).
 *
 * promptfoo is a *dev* dependency of `packages/evals/suites/judge`, and this
 * package deliberately does not import it: the report is a file the runner wrote
 * and the adapter's job is to be suspicious of it, so what is decoded here is the
 * JSON's shape, hand-checked, not promptfoo's own type. That keeps the parse
 * honest about the fields it relies on and keeps the dependency where §17 puts it.
 *
 * The report is produced by `promptfoo eval -o <file>`. The fields read below are
 * the ones verified against promptfoo 0.125.1's output — a successful run and a
 * failing one — not taken from documentation:
 *
 * ```
 * { evalId,
 *   results: { results: [ { testIdx, repeatIndex, repeatGroupId, provider: { id },
 *                           success, score, latencyMs, cost,
 *                           vars: { caseId, expectedText, case },
 *                           response: { output },
 *                           gradingResult: { reason, componentResults },
 *                           tokenUsage: { prompt, completion, cached, total } } ],
 *              stats: { successes, failures, errors, durationMs,
 *                       tokenUsage: { prompt, completion, cached, total } } } }
 * ```
 *
 * Two details matter for the events and are worth stating where they are read:
 *
 * - **A repeat is a result row, not a field of one.** §17's N=3 makes promptfoo
 *   emit three rows per case, told apart by `repeatIndex`; the case count is the
 *   number of distinct `caseId`s, and `repeats` is the widest row count per case.
 * - **`cost` is 0 when the provider did not price the run**, which is promptfoo's
 *   spelling of "unknown", not "free". The adapter therefore reports `costUsd`
 *   only for a positive total (§4 `capabilities.usageCost`).
 */

import { err, ok, type Issue, type Result } from '@fleet/foundation-core'

/** One row of the report: one case, one repeat. */
export interface ReportResult {
  readonly testIdx: number
  readonly repeatIndex: number
  /** `fleet-judge:<provider>:<model>` — the id `JudgeProvider.id()` returns. */
  readonly providerId: string
  readonly success: boolean
  readonly score: number
  readonly latencyMs: number
  readonly caseId: string
  /** The decision the case expected, already rendered; `undefined` on a report without it. */
  readonly expectedText?: string
  /** What the model answered, verbatim (the rendered decision, or the provider's error text). */
  readonly output?: string
  /** The assertion's own words, for a failure it can explain better than a diff. */
  readonly reason?: string
  readonly cost: number
  readonly tokens: { readonly prompt: number; readonly completion: number; readonly cached: number }
  /** The suite the case belongs to, from the case file itself. */
  readonly suite?: string
}

/** A decoded report: the run id and every result row, in the order promptfoo wrote them. */
export interface Report {
  readonly evalId: string
  readonly results: readonly ReportResult[]
  readonly stats: {
    readonly successes: number
    readonly failures: number
    readonly errors: number
    readonly durationMs: number
    readonly tokens: { readonly prompt: number; readonly completion: number; readonly cached: number }
  }
}

/**
 * A report that cannot be read. It is a separate error from `SchemaError` because
 * the thing being read is a file another program wrote: the message has to name
 * the field and what was there, and the caller's fix is "re-run the suite", not
 * "fix a contract".
 */
export class ReportError extends Error {
  readonly issues: readonly Issue[]

  constructor(issues: readonly Issue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '))
    this.name = 'ReportError'
    this.issues = issues
  }
}

const at = (value: unknown, ...path: readonly (string | number)[]): unknown => {
  let cursor = value
  for (const key of path) {
    if (typeof cursor === 'object' && cursor !== null && key in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[String(key)]
    } else {
      return undefined
    }
  }
  return cursor
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const tokensAt = (value: unknown): { prompt: number; completion: number; cached: number } => ({
  prompt: num(at(value, 'prompt')) ?? 0,
  completion: num(at(value, 'completion')) ?? 0,
  cached: num(at(value, 'cached')) ?? 0,
})

/**
 * Decode the `{ provider, model }` a `fleet-judge:` id carries. Anything else is
 * a refusal: a report from a provider that is not this suite's would be scored as
 * if it were, and the id is the only place the report says who answered.
 */
export const targetOf = (providerId: string): { provider: string; model: string } | undefined => {
  const parts = providerId.split(':')
  if (parts.length < 3 || parts[0] !== 'fleet-judge') return undefined
  const [, provider, ...rest] = parts
  if (provider === undefined || provider === '') return undefined
  const model = rest.join(':')
  return model === '' ? undefined : { provider, model }
}

const decodeResult = (raw: unknown, index: number, issues: Issue[]): ReportResult | undefined => {
  const path = `results.results[${index}]`
  const providerId = str(at(raw, 'provider', 'id'))
  if (providerId === undefined) {
    issues.push({ path: `${path}.provider.id`, message: 'expected a provider id' })
    return undefined
  }
  if (targetOf(providerId) === undefined) {
    issues.push({
      path: `${path}.provider.id`,
      message: `expected fleet-judge:<provider>:<model>, got ${JSON.stringify(providerId)}`,
    })
    return undefined
  }
  const caseId = str(at(raw, 'vars', 'caseId'))
  if (caseId === undefined) {
    issues.push({ path: `${path}.vars.caseId`, message: 'expected the case id in the test vars' })
    return undefined
  }
  const repeatIndex = num(at(raw, 'repeatIndex')) ?? 0
  const score = num(at(raw, 'score')) ?? 0
  const expectedText = str(at(raw, 'vars', 'expectedText'))
  const output = str(at(raw, 'response', 'output'))
  const reason = str(at(raw, 'gradingResult', 'reason'))
  const suite = str(at(raw, 'vars', 'case', 'suite'))
  return {
    testIdx: num(at(raw, 'testIdx')) ?? index,
    // promptfoo writes 0 for a run of one repeat and omits nothing; a report
    // without the key is one repeat, which is what 0 means.
    repeatIndex,
    providerId,
    success: at(raw, 'success') === true,
    // Clamped: the event contract refuses a score outside 0..1 and a report is
    // not a place to discover that promptfoo added a second scale.
    score: Math.min(1, Math.max(0, score)),
    latencyMs: num(at(raw, 'latencyMs')) ?? 0,
    caseId,
    ...(expectedText === undefined ? {} : { expectedText }),
    ...(output === undefined ? {} : { output }),
    ...(reason === undefined ? {} : { reason }),
    cost: num(at(raw, 'cost')) ?? 0,
    tokens: tokensAt(at(raw, 'tokenUsage')),
    ...(suite === undefined ? {} : { suite }),
  }
}

/** Decode a parsed report. Never throws; the `Result` names every field that was wrong. */
export const decodeReport = (value: unknown): Result<Report, ReportError> => {
  const issues: Issue[] = []
  const evalId = str(at(value, 'evalId'))
  if (evalId === undefined) issues.push({ path: 'evalId', message: 'expected the run id' })
  const rows = at(value, 'results', 'results')
  const results: ReportResult[] = []
  if (!Array.isArray(rows)) {
    issues.push({ path: 'results.results', message: 'expected the result rows' })
  } else if (rows.length === 0) {
    // A report with no rows is a suite that ran nothing: a config the runner
    // could not load, or a case directory that was empty. Scoring it as a pass
    // would be the worst outcome of all, so it is refused here.
    issues.push({ path: 'results.results', message: 'expected at least one result row' })
  } else {
    rows.forEach((row, i) => {
      const decoded = decodeResult(row, i, issues)
      if (decoded !== undefined) results.push(decoded)
    })
  }
  const stats = at(value, 'results', 'stats')
  const report: Report = {
    evalId: evalId ?? '',
    results,
    stats: {
      successes: num(at(stats, 'successes')) ?? 0,
      failures: num(at(stats, 'failures')) ?? 0,
      errors: num(at(stats, 'errors')) ?? 0,
      durationMs: num(at(stats, 'durationMs')) ?? 0,
      tokens: tokensAt(at(stats, 'tokenUsage')),
    },
  }
  return issues.length === 0 ? ok(report) : err(new ReportError(issues))
}

/** Decode a report from its file's text. Throws `ReportError`, which names every bad field. */
export const readReport = (text: string): Report => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ReportError([{ path: '<file>', message: `not JSON: ${(error as Error).message}` }])
  }
  const decoded = decodeReport(parsed)
  if (!decoded.ok) throw decoded.error
  return decoded.value
}
