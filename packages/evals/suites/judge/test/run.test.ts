/**
 * The run and its gate, tested without a model (§17).
 *
 * Every test here drives `runSuite`/`runJudge` with a fake runner that answers from a
 * script, which is the whole reason the run takes its model as an argument: CI makes no
 * model call, and N=3 folding, the "a case passes only if all three passed" rule, and
 * the baseline comparison are all arithmetic a test can pin exactly.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderDecision } from '../src/decision.ts'
import {
  BASELINE_PATH,
  BaselineError,
  DEFAULT_TOLERANCE,
  baselineFrom,
  gateFor,
  readBaseline,
  runJudge,
  runSuite,
  type Baseline,
  type SuiteRunInput,
} from '../src/index.ts'
import { readCase, type JudgeCase } from '../src/case.ts'
import type { JudgeRun } from '../src/judge-provider.ts'

/** Three well-formed cases whose ids are the only thing a test cares about. */
const cases = ['case-a', 'case-b', 'case-c'].map(
  (id) =>
    readCase(
      JSON.stringify({
        id,
        suite: 'judge',
        input: {
          kind: 'route_question',
          question: `who owns ${id}?`,
          candidates: [{ peerId: 'engineer-1', role: 'contracts' }],
        },
        expected: { kind: 'route_question', peerId: 'engineer-1' },
        source: '#61, a fixture',
      }),
      `${id}.json`,
    ) as JudgeCase,
)

const WRONG = 'route_question:peerId=engineer-3'

/**
 * A runner that passes each case the first `passes[caseId]` times and then answers
 * wrongly, so a test can produce any `passes/attempts` it needs. Each call makes a
 * fresh one, so two runs in one test cannot share a counter. No model is called.
 */
const runner = (
  passes: Readonly<Record<string, number>> = {},
): { readonly run: (c: JudgeCase) => Promise<JudgeRun>; readonly calls: Map<string, number> } => {
  const calls = new Map<string, number>()
  return {
    calls,
    run: async (c) => {
      const seen = calls.get(c.id) ?? 0
      calls.set(c.id, seen + 1)
      const allowed = passes[c.id] ?? Number.POSITIVE_INFINITY
      return { output: seen < allowed ? renderDecision(c.expected) : WRONG, durationMs: 1 }
    },
  }
}

/** One run with a scripted provider, from the same far-from-real facts every test uses. */
const run = (over: Partial<SuiteRunInput> = {}, passes: Readonly<Record<string, number>> = {}) =>
  runSuite({
    cases,
    run: runner(passes).run,
    provider: 'deepinfra',
    model: 'a-model',
    sha: 'a1b2c3d',
    now: '2026-01-01T00:00:00.000Z',
    ...over,
  })

test('a case is run N=3 times by default', async () => {
  const suite = await run()
  assert.equal(suite.results.length, 3)
  assert.deepEqual(
    suite.results.map((r) => r.attempts.length),
    [3, 3, 3],
  )
})

test('a run of a case is the number the contract names', async () => {
  const scripted = runner()
  await runSuite({
    cases,
    run: scripted.run,
    provider: 'deepinfra',
    model: 'a-model',
    sha: 'a1b2c3d',
    now: '2026-01-01T00:00:00.000Z',
    attempts: 1,
  })
  assert.deepEqual(
    cases.map((c) => scripted.calls.get(c.id)),
    [1, 1, 1],
  )
})

test('a case passes only when every attempt passed, and the report counts cases', async () => {
  const suite = await run({}, { 'case-a': 2 })
  const a = suite.results[0]
  assert.equal(a?.passes, 2)
  assert.equal(a?.rate, 2 / 3)
  // two of three attempts is not a passing case: `passed` is the strict rule §17 encodes
  assert.equal(a?.passed, false)
  assert.equal(suite.results[1]?.passed, true)
  assert.equal(suite.report.passed, 2)
  assert.equal(suite.report.cases, 3)
})

test('the events are one start, one row per attempt, and one finish', async () => {
  const suite = await run({}, { 'case-a': 2 })
  assert.equal(suite.events.started.type, 'eval.run_started')
  assert.equal(suite.events.scored.length, 9)
  assert.equal(suite.events.finished.type, 'eval.run_finished')
  const finished = suite.events.finished as { readonly data?: { readonly passed?: number; readonly cases?: number } }
  assert.equal(finished.data?.cases, 3)
  assert.equal(finished.data?.passed, 2)
})

test('a failed attempt records why, and a passing one records what was answered', async () => {
  const suite = await run({}, { 'case-a': 0 })
  const [first, second] = suite.results[0]?.attempts ?? []
  assert.equal(first?.pass, false)
  assert.match(first?.detail ?? '', /expected/)
  assert.equal(second?.score, 0)
  const passing = suite.results[1]?.attempts[0]
  assert.equal(passing?.pass, true)
  assert.match(passing?.detail ?? '', /answered/)
})

// ------------------------------------------------------------------ the gate

const baselineOf = (run_: Awaited<ReturnType<typeof run>>, tolerance = DEFAULT_TOLERANCE): Baseline =>
  baselineFrom(run_, '2026-01-01T00:00:00.000Z', tolerance)

test('with no baseline a run passes and says there is none', async () => {
  const judged = await runJudge({
    cases,
    run: runner().run,
    provider: 'deepinfra',
    model: 'a-model',
    sha: 'a1b2c3d',
    now: '2026-01-01T00:00:00.000Z',
  })
  assert.deepEqual(judged.output.gate, { kind: 'no-baseline', exitCode: 0 })
  assert.equal(judged.baseline, undefined)
})

test('--save-baseline writes the per-case counts, not a rounded rate', async () => {
  const judged = await runJudge({
    cases,
    run: runner({ 'case-a': 2 }).run,
    provider: 'deepinfra',
    model: 'a-model',
    sha: 'a1b2c3d',
    now: '2026-01-01T00:00:00.000Z',
    saveBaseline: true,
  })
  assert.deepEqual(judged.output.gate, { kind: 'saved', exitCode: 0 })
  assert.equal(judged.output.baselinePath, BASELINE_PATH)
  assert.deepEqual(judged.baseline?.cases, {
    'case-a': { attempts: 3, passes: 2 },
    'case-b': { attempts: 3, passes: 3 },
    'case-c': { attempts: 3, passes: 3 },
  })
  assert.equal(judged.baseline?.tolerance, DEFAULT_TOLERANCE)
})

test('a run that matches its baseline passes, and one case short fails by name', async () => {
  const baseline = baselineOf(await run())
  const passing = gateFor(await run(), baseline)
  assert.deepEqual(passing, { kind: 'pass', exitCode: 0 })

  const regressed = gateFor(await run({}, { 'case-b': 1 }), baseline)
  assert.equal(regressed.kind, 'regressed')
  assert.equal(regressed.exitCode, 1)
  assert.deepEqual(regressed.kind === 'regressed' ? regressed.regressions : [], [
    { caseId: 'case-b', passes: 1, attempts: 3, baselinePasses: 3, baselineAttempts: 3 },
  ])
})

test('the tolerance is a third: 2/3 is not below a perfect baseline, 1/3 is', async () => {
  const baseline = baselineOf(await run())
  // 3 − (1/3 × 3) = 2, and 2/3 of a case is exactly the line rather than under it
  assert.equal(gateFor(await run({}, { 'case-a': 2 }), baseline).kind, 'pass')
  assert.equal(gateFor(await run({}, { 'case-a': 1 }), baseline).kind, 'regressed')
})

test('a case the baseline does not know is not a regression — it is new', async () => {
  const short: Baseline = {
    suite: 'judge',
    sha: 'a1b2c3d',
    savedAt: '2026-01-01T00:00:00.000Z',
    tolerance: DEFAULT_TOLERANCE,
    cases: { 'case-a': { attempts: 3, passes: 3 } },
  }
  assert.equal(gateFor(await run({}, { 'case-b': 0, 'case-c': 0 }), short).kind, 'pass')
})

test('a baseline for another suite is refused rather than compared', async () => {
  const other = JSON.stringify({
    suite: 'other',
    sha: 'a1b2c3d',
    savedAt: '2026-01-01T00:00:00.000Z',
    tolerance: DEFAULT_TOLERANCE,
    cases: { 'case-a': { attempts: 3, passes: 3 } },
  })
  await assert.rejects(
    runJudge({
      cases,
      run: runner().run,
      provider: 'deepinfra',
      model: 'a-model',
      sha: 'a1b2c3d',
      now: '2026-01-01T00:00:00.000Z',
      baseline: other,
    }),
    BaselineError,
  )
})

test('a baseline file that is not one is refused, not half-read', () => {
  const good = { suite: 'judge', sha: 'a1b2c3d', savedAt: '2026-01-01T00:00:00.000Z', tolerance: 0.5 }
  assert.throws(() => readBaseline('not json'), /not JSON/)
  assert.throws(() => readBaseline(JSON.stringify({ ...good, cases: {} })), /no cases/)
  assert.throws(
    () => readBaseline(JSON.stringify({ ...good, cases: { a: { attempts: 3, passes: 4 } } })),
    /4 passes of 3 attempts/,
  )
  assert.throws(
    () => readBaseline(JSON.stringify({ ...good, cases: { a: { attempts: 0, passes: 0 } } })),
    /no attempts/,
  )
  assert.throws(() => readBaseline(JSON.stringify({ ...good, suite: '', cases: { a: { attempts: 3, passes: 3 } } })), /suite/)
})

test('a baseline read back compares the same way it was written', async () => {
  const saved = baselineFrom(await run({}, { 'case-a': 2 }), '2026-01-01T00:00:00.000Z')
  const read = readBaseline(JSON.stringify(saved))
  assert.deepEqual(read, saved)
  assert.equal(gateFor(await run({}, { 'case-a': 2 }), read).kind, 'pass')
})

test('the model under test is the one the report and the events name', async () => {
  const suite = await run({ provider: 'claude', model: 'a-model' })
  assert.equal(suite.report.provider, 'claude')
  assert.equal(suite.report.model, 'a-model')
  const { data } = suite.events.started as { readonly data?: { readonly provider?: string; readonly model?: string } }
  assert.equal(data?.provider, 'claude')
  assert.equal(data?.model, 'a-model')
})
