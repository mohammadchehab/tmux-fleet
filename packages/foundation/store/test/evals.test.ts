/**
 * The eval projections (architecture §17). `eval_runs` and `eval_cases` are the
 * read model over the adapter's three events, and they carry the two habits the
 * rest of the store has: a finished run can be recorded without a start, and a
 * case that arrives for a run the log never opened is an anomaly rather than a
 * silently orphaned row.
 *
 * Replay equality is asserted here too, on the eval tables alone: the store's
 * own replay test compares `ReadModel`, and these two projections are
 * deliberately not part of it (§17: they serve the standup and `fleet evals
 * compare`, not `decide()`).
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { EvalRunId, Sha } from '@fleet/foundation-core'
import type { AppendEvent } from '@fleet/foundation-contracts'
import { openSqliteStore } from '../src/index.ts'
import { fixedClock, tempStorePath } from './fixtures.ts'

const AT = '2026-11-10T12:00:00.000Z'
const RUN = 'evr_4c1d9a7b2e5f6038' as EvalRunId
const SHA = 'ffcd0091a2b3c4d5' as Sha

const started = (cases = 3): AppendEvent => ({
  ts: AT,
  type: 'eval.run_started',
  subject: RUN,
  actor: 'user',
  data: { runId: RUN, suite: 'judge', sha: SHA, provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V3.2', cases },
})

const scored = (attempt: number, pass: boolean, detail: string): AppendEvent => ({
  ts: AT,
  type: 'eval.case_scored',
  subject: RUN,
  actor: 'user',
  data: { runId: RUN, caseId: 'stacked-merge-branch-loss', attempt, pass, score: pass ? 1 : 0, detail },
})

const finished = (cases = 3, passed = 1): AppendEvent => ({
  ts: AT,
  type: 'eval.run_finished',
  subject: RUN,
  actor: 'user',
  data: {
    runId: RUN,
    suite: 'judge',
    sha: SHA,
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V3.2',
    cases,
    passed,
    tokensIn: 48_210,
    tokensOut: 3_904,
    latencyMs: 184_320,
  },
})

interface Snapshot {
  readonly runs: readonly unknown[]
  readonly cases: readonly unknown[]
  readonly anomalies: readonly unknown[]
}

/**
 * The eval tables as a comparable value. Read through a second handle on the
 * same file, because these projections have no `ReadModel` yet — the reader
 * lands with `fleet evals compare` (§17).
 */
const snapshot = (path: string): Snapshot => {
  const db = new DatabaseSync(path)
  // SQLite hands back null-prototype rows; copy them so a comparison against a
  // plain object literal is about the values and not the prototype.
  const rows = (sql: string): unknown[] => db.prepare(sql).all().map((row) => ({ ...row }))
  try {
    return {
      runs: rows(
        `SELECT run_id, suite, state, cases, passed, tokens_in, tokens_out, cost_usd, latency_ms, started_at, finished_at
         FROM eval_runs ORDER BY run_id`,
      ),
      cases: rows(
        `SELECT run_id, case_id, attempts, passes, pass, score, detail, updated_at
         FROM eval_cases ORDER BY run_id, case_id`,
      ),
      anomalies: rows('SELECT event_seq, projection, event_type FROM projection_anomalies ORDER BY event_seq, projection'),
    }
  } finally {
    db.close()
  }
}

test('a run opens as running and closes with its aggregates', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  await store.append([started(3)])
  assert.deepEqual(snapshot(path).runs, [
    {
      run_id: RUN,
      suite: 'judge',
      state: 'running',
      cases: 3,
      passed: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      started_at: AT,
      finished_at: null,
    },
  ])

  await store.append([finished(3, 1)])
  const [run] = snapshot(path).runs as { state: string; passed: number; tokens_in: number; cost_usd: number | null }[]
  assert.equal(run?.state, 'finished')
  assert.equal(run?.passed, 1)
  assert.equal(run?.tokens_in, 48_210)
  // `costUsd` was not in the event, so the column is null — 0.00 would claim a cost nobody reported.
  assert.equal(run?.cost_usd, null)
  await store.close()
})

test('a run that finishes without a start opens its own row', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  // §17's first slice records a finished run alone; the event carries the whole identity.
  await store.append([finished(10, 8)])

  const [run] = snapshot(path).runs as { state: string; cases: number; started_at: string; finished_at: string }[]
  assert.equal(run?.state, 'finished')
  assert.equal(run?.cases, 10)
  assert.equal(run?.started_at, AT, 'with no start to inherit, the finish is the only instant the row has')
  assert.equal(run?.finished_at, AT)
  await store.close()
})

test('each attempt tallies, and the row keeps the last one rather than the best one', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  await store.append([started(3), scored(1, true, 'attempt 1: exact match'), scored(2, false, 'attempt 2: escalate')])

  const [row] = snapshot(path).cases as {
    attempts: number
    passes: number
    pass: number
    score: number
    detail: string
  }[]
  assert.equal(row?.attempts, 2)
  assert.equal(row?.passes, 1, 'one of two attempts passed: the pass rate the report shows')
  assert.equal(row?.pass, 0, 'the last attempt failed, and a case that passed twice and failed once says so')
  assert.equal(row?.score, 0)
  assert.equal(row?.detail, 'attempt 2: escalate')
  await store.close()
})

test('a case for a run the log never opened is an anomaly, not a stray row', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  await store.append([scored(1, true, 'attempt 1: exact match')])

  const { cases, anomalies } = snapshot(path)
  assert.deepEqual(cases, [])
  assert.deepEqual(anomalies, [{ event_seq: 1, projection: 'evalRun', event_type: 'eval.case_scored' }])
  await store.close()
})

test('a repeated attempt number is not a second attempt', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  // The same attempt delivered twice — an append retried after a lost reply — and an older
  // attempt landing after a newer one. Neither may add to the tally or replace the verdict.
  await store.append([
    started(3),
    scored(1, true, 'attempt 1: exact match'),
    scored(1, true, 'attempt 1: exact match'),
    scored(2, false, 'attempt 2: escalate'),
    scored(1, true, 'attempt 1: exact match'),
  ])

  const { cases, anomalies } = snapshot(path)
  const [row] = cases as { attempts: number; passes: number; pass: number; detail: string }[]
  // One pass over two attempts, not three over one: a pass rate no run produced is what §17
  // gates on, so the row must not be able to hold one.
  assert.deepEqual([row?.attempts, row?.passes], [2, 1])
  assert.equal(row?.pass, 0, 'a stale attempt 1 does not un-fail attempt 2')
  assert.equal(row?.detail, 'attempt 2: escalate')
  // Discarded, not forgotten: the log said something the tally cannot take, and that is a row.
  assert.deepEqual(
    anomalies.map((one) => (one as { event_seq: number }).event_seq),
    [3, 5],
    'the two ignored arrivals, and nothing for the start or the attempts that counted',
  )
  await store.close()
})

test('a start that arrives after the run finished does not erase the result', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  await store.append([finished(3, 2)])
  const [before] = snapshot(path).runs

  // A replayed append, or a runner resuming with the runId it already used. The start is
  // identity, not a reset: the finished row keeps its state and its aggregates.
  await store.append([started(3)])
  const [after] = snapshot(path).runs as { state: string; passed: number; cases: number }[]
  assert.deepEqual(after, before, 'a start is idempotent, and never a way back to running')
  assert.equal(after?.state, 'finished')
  assert.equal(after?.passed, 2)
  assert.deepEqual(snapshot(path).anomalies, [], 'the same run opening twice is the expected repeat')
  await store.close()
})

test('a second start for the same id with a different identity is an anomaly, not an overwrite', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  await store.append([started(3), scored(1, true, 'attempt 1: exact match')])

  // A reused runId: another suite and a different denominator under an id that already has a
  // scored case. Rewriting the row would move the `cases` the pass count was measured against.
  await store.append([{ ...started(10), data: { ...started(10).data, suite: 'briefs' } } as AppendEvent])
  const [row] = snapshot(path).runs as { suite: string; cases: number }[]
  assert.deepEqual([row?.suite, row?.cases], ['judge', 3], 'the row keeps what it was opened as')
  assert.deepEqual(snapshot(path).anomalies, [
    { event_seq: 3, projection: 'evalRun', event_type: 'eval.run_started' },
  ])
  await store.close()
})

test('replaying the eval events rebuilds exactly the rows append wrote', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  const seqs = await store.append([
    started(3),
    scored(1, true, 'attempt 1: exact match'),
    scored(2, false, 'attempt 2: escalate'),
    scored(3, true, 'attempt 3: exact match'),
    // Kept in the replay on purpose: an anomaly is a row the projection wrote, so a rebuild
    // that dropped it would rebuild the tables and not the store.
    scored(3, false, 'attempt 3: escalate'),
    finished(3, 2),
  ])
  const before = snapshot(path)
  await store.close()

  const reopened = await openSqliteStore({ path, clock: fixedClock })
  await reopened.rebuild()
  await reopened.close()

  // A replay that forgot to drop `eval_cases` first would double every tally; one that forgot
  // `eval_runs` would leave the row the append wrote, so this asserts both are projections.
  assert.deepEqual(snapshot(path), before)
  const [row] = before.cases as { attempts: number; passes: number }[]
  assert.deepEqual([row?.attempts, row?.passes], [3, 2])
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6])
})
