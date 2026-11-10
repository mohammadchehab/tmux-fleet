/**
 * A decoded report becomes the three eval events §17 defines.
 *
 * The contract is engineer-1's (`packages/foundation/contracts/src/events/evals.ts`,
 * #90), and two of its decisions shape everything below:
 *
 * - **`runId` is a minted `EvalRunId`**, not promptfoo's `eval-FXJ-…` string. The
 *   log's ids are the fleet's own, so the adapter mints one per run and the
 *   promptfoo id stays in the report file, where `fleet evals run` prints it.
 * - **`passed` counts cases, not attempts** (`eval.run_finished` refines
 *   `passed <= cases`). A case run three times passes only if all three did; a
 *   case that passed twice and failed once has not passed, and the projection
 *   keeps the tally (`passes` of `attempts`) beside the last attempt's result so
 *   the flake is still visible.
 *
 * Reading the report per case is therefore a fold, not a map: the rows for one
 * `caseId` are one case's N=3 attempts, and `attempt` is 1-based because a
 * `repeatIndex` of 0 is a row and an attempt of 0 is not.
 */

import { type AppendEvent, type EvalSuite, type EventSink, evalSuites } from '@fleet/foundation-contracts'
import { type EvalRunId, type Seq, type Sha, newEvalRunId, parseStrict, sha } from '@fleet/foundation-core'
import { type Report, type ReportResult, ReportError, targetOf } from './report.ts'

/** What the caller knows and the report does not. */
export interface ReportContext {
  /**
   * The commit the suite ran against, as git spelled it. Checked against the `sha()`
   * contract here rather than trusted: an eval run that names a commit nobody can
   * check out is not a baseline anything can be compared against (§17).
   */
  readonly sha: string
  /**
   * When the report was read, as an ISO instant — the events' `ts`. Passed in
   * rather than read from the clock so a test's events are the same every run.
   */
  readonly now: string
  /** The run id, when the caller already has one; otherwise the adapter mints it. */
  readonly runId?: EvalRunId
}

/** One case's attempts, folded: what the per-case events and the run's total both need. */
interface CaseTally {
  readonly caseId: string
  readonly attempts: number
  /** Every attempt passed. The rule `eval.run_finished`'s `passed <= cases` encodes. */
  readonly passed: boolean
  /** The last attempt's word, which is what a human spot-check reads. */
  readonly last: ReportResult
}

/**
 * The suite the report covers, taken from the case files it carries. Every row must
 * name the same one: a cases directory mixing two suites would be scored as one run
 * and compared against the wrong baseline.
 */
const suiteOf = (results: readonly ReportResult[]): EvalSuite => {
  const named = [...new Set(results.map((r) => r.suite))]
  const suite = named[0]
  if (named.length !== 1 || suite === undefined || !(evalSuites as readonly string[]).includes(suite)) {
    throw new ReportError([
      {
        path: 'results.results[].vars.case.suite',
        message: `expected one suite from ${evalSuites.join(', ')}, got ${named.map((s) => JSON.stringify(s)).join(', ')}`,
      },
    ])
  }
  return suite as EvalSuite
}

/**
 * The provider and model, from the `fleet-judge:` ids the rows carry. One run is one
 * target; a report carrying two is two runs written to one file.
 */
const targetOfReport = (results: readonly ReportResult[]): { provider: string; model: string } => {
  const ids = [...new Set(results.map((r) => r.providerId))]
  const first = ids[0]
  const target = first === undefined ? undefined : targetOf(first)
  if (ids.length !== 1 || target === undefined) {
    throw new ReportError([
      {
        path: 'results.results[].provider.id',
        message: `expected one fleet-judge:<provider>:<model> across the run, got ${ids.map((s) => JSON.stringify(s)).join(', ')}`,
      },
    ])
  }
  return target
}

/**
 * What the assertion said. The expected and actual decisions are both in hand, so
 * the detail is the diff rather than promptfoo's "Custom function returned false":
 * that string names the assertion and not the mistake, and the point of this suite
 * is that a mistake is a typed decision a person can read.
 */
const detailOf = (result: ReportResult): string => {
  if (result.success) return result.output === undefined ? 'matched' : `answered ${result.output}`
  if (result.output === undefined) {
    // No output is a provider that could not answer: `callApi` returned an error
    // rather than text, so there is nothing to compare the expectation against.
    return result.reason ?? 'the provider returned no answer'
  }
  return result.expectedText === undefined
    ? `answered ${result.output}`
    : `expected ${result.expectedText} but the model answered ${result.output}`
}

/**
 * The rows folded per case, in the order the cases first appear — promptfoo writes
 * all three attempts of a case together, and a stable order makes the log readable.
 */
const tally = (results: readonly ReportResult[]): readonly CaseTally[] => {
  const byCase = new Map<string, ReportResult[]>()
  for (const row of results) {
    const seen = byCase.get(row.caseId)
    if (seen === undefined) byCase.set(row.caseId, [row])
    else seen.push(row)
  }
  return [...byCase].map(([caseId, rows]) => {
    const last = rows[rows.length - 1]
    // `byCase` only ever holds a non-empty list, so `last` is a row.
    if (last === undefined) throw new ReportError([{ path: 'results.results', message: `no rows for ${caseId}` }])
    return { caseId, attempts: rows.length, passed: rows.every((r) => r.success), last }
  })
}

/**
 * The commit, branded by the contract that owns it. A context naming something that
 * is not a sha is a caller bug, so it surfaces as a `ReportError` beside the report's
 * own refusals rather than as a cast that would launder it into the log.
 */
const commitOf = (spelled: string): Sha => {
  try {
    return parseStrict(sha(), spelled)
  } catch (error) {
    throw new ReportError([{ path: 'context.sha', message: (error as Error).message }])
  }
}

/** The events a report becomes. Throws `ReportError` on a report it cannot place. */
export interface ReportEvents {
  readonly runId: EvalRunId
  readonly started: AppendEvent
  /** One event per *attempt*: a case run N=3 times writes three rows (§17). */
  readonly scored: readonly AppendEvent[]
  readonly finished: AppendEvent
}

export const eventsFromReport = (report: Report, context: ReportContext): ReportEvents => {
  if (report.results.length === 0) {
    throw new ReportError([{ path: 'results.results', message: 'a report with no case-runs scores nothing' }])
  }
  const suite = suiteOf(report.results)
  const target = targetOfReport(report.results)
  const runId = context.runId ?? newEvalRunId()
  const subject = runId
  const cases = tally(report.results)

  /** Cases whose every attempt passed — the only count `eval.run_finished` allows. */
  const passed = cases.filter((c) => c.passed).length

  /**
   * promptfoo reports `cost: 0` for a provider that does not price the run, which is
   * its spelling of "unknown" (§4, §11). A zero total is omitted rather than
   * recorded as free: the spend ledger must not gain a number no vendor gave.
   */
  const costUsd = report.results.reduce((sum, r) => sum + r.cost, 0)

  const head = {
    runId,
    suite,
    sha: commitOf(context.sha),
    provider: target.provider,
    model: target.model,
  } as const

  return {
    runId,
    started: {
      type: 'eval.run_started',
      ts: context.now,
      subject,
      actor: 'scheduler',
      data: { ...head, cases: cases.length },
    } as AppendEvent,
    scored: report.results.map(
      (row) =>
        ({
          type: 'eval.case_scored',
          ts: context.now,
          subject,
          actor: 'scheduler',
          data: {
            runId,
            caseId: row.caseId,
            // 1-based: a `repeatIndex` of 0 is a row, an `attempt` of 0 is not (§17).
            attempt: row.repeatIndex + 1,
            pass: row.success,
            score: row.score,
            detail: detailOf(row).slice(0, 2000),
          },
        }) as AppendEvent,
    ),
    finished: {
      type: 'eval.run_finished',
      ts: context.now,
      subject,
      actor: 'scheduler',
      data: {
        ...head,
        cases: cases.length,
        passed,
        tokensIn: report.stats.tokens.prompt,
        tokensOut: report.stats.tokens.completion,
        ...(costUsd > 0 ? { costUsd } : {}),
        // The run's wall clock. Per-case latency is in the CLI's report, which reads
        // the rows directly; the event keeps the total, which is the standup's number.
        latencyMs: Math.max(0, Math.round(report.stats.durationMs)),
      },
    } as AppendEvent,
  }
}

/** What a completed append wrote. */
export interface AppendedRun {
  readonly runId: EvalRunId
  /** The `eval.run_started` seq; the rows and the total cite it. */
  readonly startedSeq: Seq
  /** Every seq written, in order: the start, each attempt, the total. */
  readonly seqs: readonly Seq[]
}

/**
 * Append a report's events: the start, so it has a seq to cite, then the rows and
 * the total in one batch. Two appends rather than one because the citation is a seq
 * and a seq is assigned by the store (§3), and the rows are one batch because a run
 * reported in halves is worse than a run not reported at all.
 *
 * A throw here (`ReportError`) means nothing was written: the report was decoded and
 * placed before the first append. A rejected second append leaves an unmatched
 * `eval.run_started`, which is the visible failure §17 wants for a report that could
 * not be recorded: the projection keeps it `running` forever and `fleet evals` shows
 * it.
 */
export const appendReport = async (
  sink: EventSink,
  report: Report,
  context: ReportContext,
): Promise<AppendedRun> => {
  const events = eventsFromReport(report, context)
  const [startedSeq] = await sink.append([events.started])
  if (startedSeq === undefined) throw new Error('the store returned no seq for eval.run_started')
  const cited = (event: AppendEvent): AppendEvent => ({ ...event, causedBy: [startedSeq] }) as AppendEvent
  const rest = [...events.scored.map(cited), cited(events.finished)]
  const restSeqs = await sink.append(rest)
  return { runId: events.runId, startedSeq, seqs: [startedSeq, ...restSeqs] }
}
