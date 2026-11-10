/**
 * The adapter against reports promptfoo actually wrote.
 *
 * The two fixtures are a successful run and a failing one, captured from
 * promptfoo 0.125.1 and trimmed to the fields the adapter reads. Their job is to
 * catch the report shape changing under us: a promptfoo upgrade that renames
 * `repeatIndex` or moves `providerId` fails here, at the adapter, rather than in
 * the nightly gate reading zeros.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { type AppendEvent, fleetEvent } from '@fleet/foundation-contracts'
import { newEvalRunId, parseStrict } from '@fleet/foundation-core'
import { appendReport, eventsFromReport, readReport } from '../src/index.ts'
import { ReportError, decodeReport, targetOf } from '../src/report.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/report-${name}.json`, import.meta.url), 'utf8')

/** The fixture's text with one row changed, so the *decoder* sees the change and not just a mutated object. */
const withRow = (name: string, index: number, change: (row: Record<string, unknown>) => void): string => {
  const doc = JSON.parse(fixture(name)) as { results: { results: Record<string, unknown>[] } }
  const row = doc.results.results[index]
  assert.ok(row !== undefined)
  change(row)
  return JSON.stringify(doc)
}

const context = { sha: '3ee0e6731a4f0c1b9d2e8a7f5c4b3a2d1e0f9c8b', now: '2026-11-10T10:54:30.000Z' }

test('a passing run becomes a start, one row per repeat, and a total', () => {
  const report = readReport(fixture('pass'))
  const events = eventsFromReport(report, context)

  assert.equal(events.started['type'], 'eval.run_started')
  assert.equal(events.scored.length, 3, 'N=3 rows for one case')
  assert.equal(events.finished['type'], 'eval.run_finished')

  const started = events.started as Extract<AppendEvent, { type: 'eval.run_started' }>
  assert.equal(started.data.suite, 'judge')
  assert.equal(started.data.provider, 'claude')
  assert.equal(started.data.model, 'claude-haiku-4-5')
  assert.equal(started.data.cases, 1, 'one case, not three case-runs')
  assert.match(
    events.runId,
    /^evr_[0-9a-f]{16}$/,
    'the run id is the fleet’s own, minted — promptfoo’s eval id is not an EvalRunId',
  )
  assert.equal(started.subject, events.runId, 'the run is the subject of its own events')
  assert.notEqual(started.subject, report.evalId, 'promptfoo’s id stays in the report file')

  const finished = events.finished as Extract<AppendEvent, { type: 'eval.run_finished' }>
  assert.equal(finished.data.cases, 1)
  assert.equal(finished.data.passed, 1, 'passed counts cases')
  assert.equal(finished.data.tokensIn, 90)
  assert.equal(finished.data.tokensOut, 36)
  assert.equal(finished.data.latencyMs, 23)
})

test('a case that failed one of its three attempts does not count as passed', () => {
  // §17's N=3 with the projection's rule: "a case run three times passes only if
  // all three did". A flake is not a pass, and `passed <= cases` is the contract
  // saying so — counting case-runs would have said 2 of 1 here.
  const report = readReport(withRow('pass', 1, (row) => { row['success'] = false }))
  const events = eventsFromReport(report, context)
  const scored = events.scored as readonly Extract<AppendEvent, { type: 'eval.case_scored' }>[]
  assert.deepEqual(scored.map((e) => e.data.pass), [true, false, true], 'the per-attempt rows keep the flake')
  assert.deepEqual(scored.map((e) => e.data.attempt), [1, 2, 3], 'attempts are 1-based')

  const finished = events.finished as Extract<AppendEvent, { type: 'eval.run_finished' }>
  assert.equal(finished.data.passed, 0, 'two of three is not a pass')
  assert.ok(finished.data.passed <= finished.data.cases)
})

test('a caller that already has a run id keeps it', () => {
  const report = readReport(fixture('pass'))
  const runId = newEvalRunId()
  const events = eventsFromReport(report, { ...context, runId })
  assert.equal(events.runId, runId)
  const started = events.started as Extract<AppendEvent, { type: 'eval.run_started' }>
  assert.equal(started.data.runId, runId)
})

test('every event the adapter writes is a registered eval event', () => {
  const report = readReport(fixture('fail'))
  const events = eventsFromReport(report, context)
  // The point: the adapter cannot invent a type or a field. `parseStrict` is the
  // same check `Store.append` makes, so a payload that drifts from the contract
  // fails here rather than at the append.
  for (const event of [events.started, ...events.scored, events.finished]) {
    // The store assigns `seq`; a payload is everything else, so the check adds one.
    const parsed = parseStrict(fleetEvent(), { seq: 1, ...event }) as AppendEvent
    assert.ok(parsed.type.startsWith('eval.'), `not an eval event: ${parsed.type}`)
  }
})

test('a failed case carries the diff, not the assertion source', () => {
  const report = readReport(fixture('fail'))
  const [first] = eventsFromReport(report, context).scored
  assert.ok(first !== undefined)
  const scored = first as Extract<AppendEvent, { type: 'eval.case_scored' }>
  assert.equal(scored.data.pass, false)
  assert.equal(scored.data.score, 0)
  assert.equal(
    scored.data.detail,
    'expected {"kind":"route_question","peerId":"engineer-3"} but the model answered {"kind":"route_question","peerId":null}',
  )
  assert.equal(scored.data.attempt, 1)
})

test('a passing case says what the model answered', () => {
  const report = readReport(fixture('pass'))
  const [first] = eventsFromReport(report, context).scored
  const scored = first as Extract<AppendEvent, { type: 'eval.case_scored' }>
  assert.equal(scored.data.detail, 'answered {"kind":"route_question","peerId":"engineer-3"}')
})

test('cost is omitted when the provider did not price the run', () => {
  // promptfoo writes `cost: 0` for a provider that does not measure cost, which is
  // "unknown", not "free" (§4, §11). The event must not gain a number nobody gave.
  const report = readReport(fixture('pass'))
  const finished = eventsFromReport(report, context).finished as Extract<AppendEvent, { type: 'eval.run_finished' }>
  assert.equal('costUsd' in finished.data, false)
})

test('cost is recorded when a row priced the run', () => {
  const report = readReport(fixture('pass'))
  const priced = {
    ...report,
    results: report.results.map((r) => ({ ...r, cost: 0.0042 })),
  }
  const finished = eventsFromReport(priced, context).finished as Extract<AppendEvent, { type: 'eval.run_finished' }>
  assert.equal(finished.data.costUsd, 0.0126)
})

test('a report naming two suites is refused: it is two runs, not one', () => {
  const report = readReport(fixture('pass'))
  const mixed = {
    ...report,
    results: report.results.map((r, i) => (i === 0 ? { ...r, suite: 'briefs' } : r)),
  }
  assert.throws(() => eventsFromReport(mixed, context), ReportError)
})

test('a report naming two providers is refused', () => {
  const report = readReport(fixture('pass'))
  const mixed = {
    ...report,
    results: report.results.map((r, i) => (i === 0 ? { ...r, providerId: 'fleet-judge:deepinfra:deepseek-ai/DeepSeek-V4.1-Flash-1017' } : r)),
  }
  assert.throws(() => eventsFromReport(mixed, context), ReportError)
})

test('an empty report scores nothing and is refused', () => {
  assert.throws(() => readReport(JSON.stringify({ evalId: 'eval-x', results: { results: [], stats: {} } })), ReportError)
})

test('a report from a provider the suite does not own is refused, naming the id', () => {
  const report = readReport(fixture('pass'))
  const foreign = { ...report, results: report.results.map((r) => ({ ...r, providerId: 'openai:gpt' })) }
  assert.throws(
    () => eventsFromReport(foreign, context),
    (error: unknown) => error instanceof ReportError && /fleet-judge:<provider>:<model> across the run/.test(error.message),
  )
})

test('a row without a case id is refused: it cannot be scored against a case', () => {
  const text = withRow('pass', 0, (row) => {
    delete (row['vars'] as Record<string, unknown>)['caseId']
  })
  const decoded = decodeReport(JSON.parse(text))
  assert.equal(decoded.ok, false)
  assert.match(decoded.ok ? '' : decoded.error.message, /vars\.caseId/)
})

test('a score outside 0..1 is clamped rather than rejected', () => {
  // The event contract refuses a score above 1; a report is not the place to find
  // out that promptfoo added a scale, so the decoder clamps and the run still lands.
  const report = readReport(withRow('pass', 0, (row) => { row['score'] = 1.7 }))
  const [first] = eventsFromReport(report, context).scored
  assert.equal((first as Extract<AppendEvent, { type: 'eval.case_scored' }>).data.score, 1)
})

test('targetOf splits a fleet-judge id and refuses anything else', () => {
  assert.deepEqual(targetOf('fleet-judge:deepinfra:deepseek-ai/DeepSeek-V4.1-Flash-1017'), {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  })
  assert.equal(targetOf('claude:claude-haiku-4-5'), undefined)
  assert.equal(targetOf('fleet-judge:claude'), undefined)
  assert.equal(targetOf('fleet-judge::model'), undefined)
})

test('appendReport cites the start from every row and the total', async () => {
  const batches: AppendEvent[][] = []
  let seq = 0
  const sink = {
    append: async (batch: readonly AppendEvent[]) => {
      batches.push([...batch])
      return batch.map(() => ++seq)
    },
  }
  const report = readReport(fixture('pass'))
  const appended = await appendReport(sink, report, context)

  assert.equal(batches.length, 2, 'the start, then everything that cites it')
  assert.equal(appended.startedSeq, 1)
  assert.deepEqual(appended.seqs, [1, 2, 3, 4, 5])
  for (const event of batches[1] ?? []) assert.deepEqual(event.causedBy, [1])
})

test('a context naming something that is not a commit is refused', () => {
  // The run names the commit it scored. A baseline nothing can be checked out at is
  // not a baseline, so the sha is one more thing the adapter refuses rather than casts.
  const report = readReport(fixture('pass'))
  assert.throws(
    () => eventsFromReport(report, { ...context, sha: 'HEAD' }),
    (error: unknown) => error instanceof ReportError && /context\.sha/.test(error.message),
  )
})

test('a report that cannot be placed writes nothing', async () => {
  const batches: AppendEvent[][] = []
  const sink = { append: async (batch: readonly AppendEvent[]) => (batches.push([...batch]), [1]) }
  const report = readReport(fixture('pass'))
  const mixed = { ...report, results: report.results.map((r, i) => (i === 0 ? { ...r, suite: 'briefs' } : r)) }
  await assert.rejects(() => appendReport(sink, mixed, context), ReportError)
  assert.equal(batches.length, 0, 'the refusal happens before the first append')
})
