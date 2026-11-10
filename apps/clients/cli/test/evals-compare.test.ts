/**
 * `fleet evals compare`'s output (§17).
 *
 * The rules being pinned are the ones a person reads a comparison with: a rate
 * arrives with its count and never under the floor, a cost nobody reported is
 * `n/a`, a run without a result has no delta, and a regression is named with the
 * tallies that tell a flake from a break.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { EvalRunId, Sha } from '@fleet/foundation-core'
import type { EvalCase, EvalRunWithCases } from '@fleet/foundation-contracts'
import { formatEvalCompare } from '../src/evals-compare.ts'
import { RATE_FLOOR } from '../src/evals-report.ts'

const AT = '2026-11-10T12:00:00.000Z'
const SHA = 'ffcd0091a2b3c4d5e6f708192a3b4c5d6e7f8091' as Sha

const evalCase = (caseId: string, passes: number, attempts = 3): EvalCase => ({
  runId: 'evr_0000000000000001' as EvalRunId,
  caseId,
  attempts,
  passes,
  pass: passes === attempts,
  score: passes / attempts,
  detail: 'last attempt',
  updatedAt: AT,
})

const runWith = (fields: Partial<EvalRunWithCases['run']> = {}, cases: readonly EvalCase[] = []): EvalRunWithCases => ({
  run: {
    runId: 'evr_0000000000000001' as EvalRunId,
    suite: 'judge',
    sha: SHA,
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V3.2',
    cases: cases.length === 0 ? RATE_FLOOR : cases.length,
    state: 'finished',
    passed: cases.filter((row) => row.pass).length,
    tokensIn: 48_210,
    tokensOut: 3_904,
    latencyMs: 184_320,
    startedAt: AT,
    finishedAt: AT,
    ...fields,
  },
  cases,
})

const manyCases = (passing: number): readonly EvalCase[] =>
  Array.from({ length: RATE_FLOOR }, (_, index) => evalCase(`case-${String(index)}`, index < passing ? 3 : 0))

describe('evals compare', () => {
  it('shows each run with its count and its rate, and the delta between them', () => {
    const text = formatEvalCompare(runWith({}, manyCases(18)), runWith({}, manyCases(20)))
    assert.match(text, /20 of 20 cases passed \(100\.0%\)/)
    assert.match(text, /18 of 20 cases passed \(90\.0%\)/)
    assert.match(text, /delta {5}\+2 cases \(\+10\.0 pt\)/)
  })

  it('a run under the floor has no rate and says why, on both sides', () => {
    const small = [evalCase('only-case', 3)]
    const text = formatEvalCompare(runWith({}, small), runWith({}, small))
    assert.match(text, /1 of 1 cases passed {2}→ {2}1 of 1 cases passed/)
    assert.doesNotMatch(text, /%\)/, 'no percentage anywhere: neither run has a rate')
    assert.match(text, /no pass rate under 20 cases: 1 graded in a/)
    assert.match(text, /no pass rate under 20 cases: 1 graded in b/)
    assert.match(text, /delta {5}0 cases/, 'the count is still shown, without a rate to go with it')
  })

  it('names a regression with both tallies, so a flake does not read as a break', () => {
    const before = [evalCase('stacked-merge', 3), evalCase('dead-session', 3)]
    const after = [evalCase('stacked-merge', 2), evalCase('dead-session', 0)]
    const text = formatEvalCompare(runWith({}, before), runWith({}, after))
    assert.match(text, /regressed {2}2 cases/)
    assert.match(text, /dead-session {2}3\/3 → 0\/3/)
    assert.match(text, /stacked-merge {2}3\/3 → 2\/3/)
    assert.match(text, /fixed {6}none/)
  })

  it('names a case that only one run scored, because a different denominator is not a delta', () => {
    const text = formatEvalCompare(runWith({}, [evalCase('kept', 3), evalCase('retired', 3)]), runWith({}, [evalCase('kept', 3)]))
    assert.match(text, /only in a {2}1 case: retired/)
    assert.doesNotMatch(text, /only in b/)
  })

  it('a run still running has no result, so there is nothing to subtract', () => {
    const text = formatEvalCompare(
      runWith({ passed: undefined, state: 'running' }),
      runWith({}, manyCases(20)),
    )
    assert.match(text, /20 cases, no result yet/)
    assert.match(text, /delta {5}n\/a: a run without a result has nothing to subtract/)
    assert.match(text, /judge at ffcd009 · deepinfra\/deepseek-ai\/DeepSeek-V3\.2 · running/)
  })

  it('a cost nobody reported is n/a on that side and a number on the other', () => {
    const text = formatEvalCompare(
      runWith({ costUsd: undefined }, manyCases(18)),
      runWith({ costUsd: 0.0421 }, manyCases(20)),
    )
    assert.match(text, /cost {6}n\/a \(the provider does not report it\) {2}→ {2}\$0\.0421/)
  })

  it('two suites are not compared case by case, and the header says so before the counts', () => {
    const text = formatEvalCompare(
      runWith({ suite: 'judge' }, [evalCase('a', 3)]),
      runWith({ suite: 'briefs' }, [evalCase('a', 0)]),
    )
    assert.match(text, /different suites, judge against briefs: no case is compared/)
    assert.doesNotMatch(text, /regressed/, 'a case from another suite is not a regression')
  })

  it('two models are named even when the suite matches', () => {
    const text = formatEvalCompare(runWith({ model: 'one' }, manyCases(20)), runWith({ model: 'two' }, manyCases(20)))
    assert.match(text, /different models, one against two/)
  })
})
