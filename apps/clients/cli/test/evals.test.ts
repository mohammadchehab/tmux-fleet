/**
 * `fleet evals run`'s two mechanical halves, tested without spawning anything: the
 * command it would run, and the decode of the JSON the runner prints.
 *
 * The run itself is not spawned here — that would need a model — so what is pinned is
 * the contract at the process boundary: which bin, which arguments, which environment,
 * and what counts as an answer.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FleetError } from '@fleet/foundation-core'
import { evalsCommand, readEvalsOutput } from '../src/evals.ts'

const now = '2026-11-10T09:00:00.000Z'

describe('evalsCommand: the process the CLI spawns', () => {
  it('is the suite\'s own bin, named for it, with no arguments', () => {
    const command = evalsCommand({ suite: 'judge' })
    assert.equal(command.command, 'fleet-evals-judge')
    assert.deepEqual(command.args, [])
  })

  it('passes --save-baseline through as the one argument a run has', () => {
    assert.deepEqual(evalsCommand({ suite: 'judge', saveBaseline: true }).args, ['--save-baseline'])
    assert.deepEqual(evalsCommand({ suite: 'judge', saveBaseline: false }).args, [])
  })

  it('names the model under test in the environment, the spelling the suite documents', () => {
    const { env } = evalsCommand({ suite: 'judge', provider: 'claude', model: 'a-model' })
    assert.equal(env['FLEET_EVAL_PROVIDER'], 'claude')
    assert.equal(env['FLEET_EVAL_MODEL'], 'a-model')
  })

  it('carries PATH over, because spawn replaces the environment rather than extending it', () => {
    const { env } = evalsCommand({ suite: 'judge', env: { PATH: '/usr/bin', FLEET_EVALS_BIN: '/repo/bin/judge.ts' } })
    assert.equal(env['PATH'], '/usr/bin')
    assert.equal(env['FLEET_EVALS_BIN'], '/repo/bin/judge.ts')
  })

  it('lets FLEET_EVALS_BIN name the binary, and an explicit one win over it', () => {
    const env = { FLEET_EVALS_BIN: '/repo/bin/judge.ts' }
    assert.equal(evalsCommand({ suite: 'judge', env }).command, '/repo/bin/judge.ts')
    assert.equal(evalsCommand({ suite: 'judge', env, bin: '/other/judge.ts' }).command, '/other/judge.ts')
  })
})

describe('readEvalsOutput: the run\'s answer', () => {
  const answer = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      runId: 'evr_0123456789abcdef',
      report: {
        suite: 'judge',
        provider: 'deepinfra',
        model: 'a-model',
        sha: 'a1b2c3d4e5f6',
        cases: 2,
        passed: 1,
        tokens: { input: 0, output: 0 },
        latencyMs: [10, 20],
        retries: 0,
      },
      gate: { kind: 'pass', exitCode: 0 },
      events: { started: { type: 'eval.run_started' }, scored: [{ type: 'eval.case_scored' }], finished: { type: 'eval.run_finished' } },
      ...over,
    })

  it('reads the report, the verdict and the rows', () => {
    const decoded = readEvalsOutput(answer())
    assert.equal(decoded.runId, 'evr_0123456789abcdef')
    assert.deepEqual(decoded.gate, { kind: 'pass', exitCode: 0 })
    assert.equal(decoded.report.cases, 2)
    assert.deepEqual(decoded.events.scored.map((e) => e.type), ['eval.case_scored'])
  })

  it('reads a cost only when the provider reported one', () => {
    assert.equal(readEvalsOutput(answer()).report.costUsd, undefined)
    const priced = answer({
      report: { ...JSON.parse(answer()).report, costUsd: 0.25 },
    })
    assert.equal(readEvalsOutput(priced).report.costUsd, 0.25)
  })

  it('refuses an answer that is not JSON, and one with no rows to append', () => {
    assert.throws(() => readEvalsOutput('judge: case-a\n'), FleetError)
    assert.throws(() => readEvalsOutput(answer({ events: { started: {}, finished: {} } })), /no scored cases/)
    assert.throws(() => readEvalsOutput(answer({ events: { started: {}, scored: [], finished: {} } })), /with no event type/)
  })

  it('refuses a verdict it does not know', () => {
    assert.throws(() => readEvalsOutput(answer({ gate: { kind: 'flaky', exitCode: 0 } })), /unknown verdict/)
  })
})
