/**
 * The report's one rule that is easy to get wrong: a rate on ten cases.
 *
 * §17 says the report shows a pass rate with the case count and never a
 * percentage under twenty cases. These tests pin both halves — the count always,
 * the percentage only above the floor — so a later "just always show it" cannot
 * pass quietly.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatEvalRun, passRate, RATE_FLOOR, type EvalRunReport } from '../src/evals-report.ts'

const report = (over: Partial<EvalRunReport> = {}): EvalRunReport => ({
  runId: 'evr_4c1d9a7b2e5f6038' as EvalRunReport['runId'],
  suite: 'judge',
  provider: 'deepinfra',
  model: 'some/model',
  sha: 'a'.repeat(40),
  cases: 10,
  passed: 8,
  tokens: { input: 1234, output: 567 },
  latencyMs: [900, 1200, 1500],
  retries: 2,
  ...over,
})

test('§17: ten cases report a count and no percentage', () => {
  const text = formatEvalRun(report())
  assert.match(text, /8 of 10 cases passed/)
  assert.doesNotMatch(text, /%/, 'a percentage under the floor is the thing §17 forbids')
  assert.match(text, new RegExp(`no pass rate under ${String(RATE_FLOOR)} cases: 10 graded`))
})

test('§17: at the floor the rate appears, and the floor line does not', () => {
  const text = formatEvalRun(report({ cases: RATE_FLOOR, passed: 18 }))
  assert.match(text, /18 of 20 cases passed \(90\.0%\)/)
  assert.doesNotMatch(text, /no pass rate under/)
})

test('§17: one case under the floor is still a count, not 0.0% or 100.0%', () => {
  const text = formatEvalRun(report({ cases: RATE_FLOOR - 1, passed: RATE_FLOOR - 1 }))
  assert.match(text, /19 of 19 cases passed/)
  assert.doesNotMatch(text, /%/)
})

test('passRate is undefined under the floor and the ratio at or above it', () => {
  assert.equal(passRate(report({ cases: 10 })), undefined)
  assert.equal(passRate(report({ cases: 20, passed: 5 })), 0.25)
})

test('§17: tokens, latency and retries are always recorded', () => {
  const text = formatEvalRun(report())
  assert.match(text, /in 1234 · out 567/)
  assert.match(text, /1\.2 s mean, 1\.5 s worst/)
  assert.match(text, /retries {3}2/)
})

test('§17: cost prints as n/a when the provider does not report it, never as 0', () => {
  assert.match(formatEvalRun(report()), /cost {6}n\/a \(the provider does not report it\)/)
  assert.match(formatEvalRun(report({ costUsd: 0.0421 })), /cost {6}\$0\.0421/)
})

test('a run with no cases does not divide by zero', () => {
  const text = formatEvalRun(report({ cases: 0, passed: 0, latencyMs: [] }))
  assert.match(text, /0 of 0 cases passed/)
  assert.match(text, /latency {3}-/)
})

test('the run id is printed whole, because it is what `compare` takes', () => {
  // Not elided like the sha: a truncated id is a run nobody can name, and the
  // report is the only place a finished run's name appears.
  assert.match(formatEvalRun(report()), /run {7}evr_4c1d9a7b2e5f6038/)
})
