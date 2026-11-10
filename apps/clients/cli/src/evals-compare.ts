/**
 * What `fleet evals compare <runA> <runB>` prints (§17).
 *
 * A comparison is a reading of two runs, not a verdict. The gate asks a
 * different question with a different input — a run against its committed
 * baseline — so nothing here says "pass" or "fail": it shows the two runs, the
 * delta between them, and the cases that changed hands, and leaves the judgement
 * to the person reading. Two runs of different suites are not comparable case by
 * case, and the output says so before the counts are read rather than after.
 *
 * Two rules come over from `evals-report.ts` unchanged, because a comparison is
 * read the same way a single run is: a pass rate is shown with its case count
 * and never below `RATE_FLOOR` cases, and a cost the provider did not report is
 * `n/a`, never `$0.00` — "free" and "unknown" are different facts.
 *
 * A run that is still `running` is labelled as such in its header line: half a
 * run beside a finished one is a short case list beside a long one, and that has
 * to be visible before the numbers under it are believed.
 */

import type { EvalCase, EvalRun, EvalRunWithCases } from '@fleet/foundation-contracts'

import { RATE_FLOOR } from './evals-report.ts'

const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`

const points = (delta: number): string => `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)} pt`

const duration = (ms: number): string => (ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`)

const cost = (run: EvalRun): string =>
  run.costUsd === undefined ? 'n/a (the provider does not report it)' : `$${run.costUsd.toFixed(4)}`

const tokens = (run: EvalRun): string =>
  run.tokensIn === undefined || run.tokensOut === undefined
    ? 'n/a (the run reported no tokens)'
    : `${run.tokensIn.toLocaleString('en-US')} in · ${run.tokensOut.toLocaleString('en-US')} out`

const latency = (run: EvalRun): string => (run.latencyMs === undefined ? 'n/a' : duration(run.latencyMs))

/** `evr_… · judge at ffcd009 · deepinfra/DeepSeek-V3.2 · finished`. */
const identity = (run: EvalRun): string =>
  [String(run.runId), `${run.suite} at ${run.sha.slice(0, 7)}`, `${run.provider}/${run.model}`, run.state].join(' · ')

/** `9 of 10 cases passed (90.0%)`; under the floor the count alone, with a note below it. */
const counted = (run: EvalRun): string => {
  if (run.passed === undefined) return `${String(run.cases)} cases, no result yet`
  const count = `${String(run.passed)} of ${String(run.cases)} cases passed`
  return run.cases < RATE_FLOOR ? count : `${count} (${percent(run.passed / run.cases)})`
}

/** A run whose rate was withheld says why, so an absent percentage is never read as an oversight (§17). */
const floorNote = (label: string, run: EvalRun): readonly string[] =>
  run.passed !== undefined && run.cases < RATE_FLOOR
    ? [`  note      no pass rate under ${String(RATE_FLOOR)} cases: ${String(run.cases)} graded in ${label}`]
    : []

/** `+1 case (+10.0 pt)`; the point delta needs both rates, so under the floor it is the count alone. */
const delta = (a: EvalRun, b: EvalRun): string => {
  if (a.passed === undefined || b.passed === undefined) return 'n/a: a run without a result has nothing to subtract'
  const cases = b.passed - a.passed
  const word = `${cases > 0 ? '+' : ''}${String(cases)} case${Math.abs(cases) === 1 ? '' : 's'}`
  if (a.cases < RATE_FLOOR || b.cases < RATE_FLOOR) return word
  return `${word} (${points(b.passed / b.cases - a.passed / a.cases)})`
}

/** One changed case, with both tallies: `3/3 → 2/3` is a flake, `3/3 → 0/3` is a break. */
const tally = (row: EvalCase): string => `${String(row.passes)}/${String(row.attempts)}`

const changed = (label: string, rows: readonly { readonly was: EvalCase; readonly now: EvalCase }[]): readonly string[] =>
  rows.length === 0
    ? [`  ${label}  none`]
    : [
        `  ${label}  ${String(rows.length)} case${rows.length === 1 ? '' : 's'}`,
        ...rows.map(({ was, now }) => `               ${was.caseId}  ${tally(was)} → ${tally(now)}`),
      ]

/**
 * The cases, side by side.
 *
 * A case is compared on `pass` — the run's verdict on it — and the tally is
 * printed beside it so a case that moved from `3/3` to `2/3` is not read as a
 * suite that broke. A case only on one side is named as such: a run that scored
 * fewer cases than the other has a different denominator, and a delta over it
 * would compare two different things.
 */
const cases = (a: EvalRunWithCases, b: EvalRunWithCases): readonly string[] => {
  const sameSuite = a.run.suite === b.run.suite
  const notes = [
    ...(sameSuite ? [] : [`  note      different suites, ${a.run.suite} against ${b.run.suite}: no case is compared`]),
    ...(a.run.model === b.run.model ? [] : [`  note      different models, ${a.run.model} against ${b.run.model}`]),
  ]
  if (!sameSuite) return notes

  const before = new Map(a.cases.map((row) => [row.caseId, row]))
  const after = new Map(b.cases.map((row) => [row.caseId, row]))
  const pairs = [...before.values()].flatMap((was) => {
    const now = after.get(was.caseId)
    return now === undefined ? [] : [{ was, now }]
  })
  const onlyIn = (label: string, mine: readonly EvalCase[], theirs: ReadonlyMap<string, EvalCase>): readonly string[] => {
    const missing = mine.filter((row) => !theirs.has(row.caseId))
    if (missing.length === 0) return []
    const list = missing.map((row) => row.caseId).join(', ')
    return [`  ${label}  ${String(missing.length)} case${missing.length === 1 ? '' : 's'}: ${list}`]
  }

  return [
    ...notes,
    ...changed('regressed', pairs.filter(({ was, now }) => was.pass && !now.pass)),
    ...changed('fixed    ', pairs.filter(({ was, now }) => !was.pass && now.pass)),
    ...onlyIn('only in a', a.cases, after),
    ...onlyIn('only in b', b.cases, before),
  ]
}

/**
 * The two runs, one under the other. Scalar facts are `a → b` on one line, so a
 * difference is found by looking down one column; the cases are sections,
 * because a list of changed cases has no single value to sit beside another.
 */
export const formatEvalCompare = (a: EvalRunWithCases, b: EvalRunWithCases): string =>
  [
    `  run a     ${identity(a.run)}`,
    `  run b     ${identity(b.run)}`,
    `  cases     ${counted(a.run)}  →  ${counted(b.run)}`,
    ...floorNote('a', a.run),
    ...floorNote('b', b.run),
    `  delta     ${delta(a.run, b.run)}`,
    `  tokens    ${tokens(a.run)}  →  ${tokens(b.run)}`,
    `  cost      ${cost(a.run)}  →  ${cost(b.run)}`,
    `  latency   ${latency(a.run)}  →  ${latency(b.run)}`,
    ...cases(a, b),
  ].join('\n')
