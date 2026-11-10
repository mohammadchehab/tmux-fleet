/**
 * `fleet evals run`'s mechanical halves, tested without a daemon or a model: the
 * command it asks the ledger to run, the file it reads the answer from, and the decode
 * of what the suite prints.
 *
 * What is pinned is the contract at the process boundary — which bin, which arguments,
 * and which environment (only two variables, because they cross a socket) — plus what
 * counts as an answer.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { FleetError } from '@fleet/foundation-core'
import { evalsBuildCommand, readEvalsAnswer, readEvalsOutput } from '../src/evals.ts'

const now = '2026-11-10T09:00:00.000Z'

describe('evalsBuildCommand: the build the CLI asks for', () => {
  const run = { suite: 'judge', provider: 'claude', model: 'a-model', saveBaseline: false }

  it("is the suite's own bin, named for it, with no arguments", () => {
    const command = evalsBuildCommand(run)
    assert.equal(command.bin, 'fleet-evals-judge')
    assert.deepEqual(command.args, [])
  })

  it('passes --save-baseline through as the one argument a run has', () => {
    assert.deepEqual(evalsBuildCommand({ ...run, saveBaseline: true }).args, ['--save-baseline'])
  })

  it('names the model under test in the environment, the spelling the suite documents', () => {
    const { env } = evalsBuildCommand(run)
    assert.equal(env['FLEET_EVAL_PROVIDER'], 'claude')
    assert.equal(env['FLEET_EVAL_MODEL'], 'a-model')
  })

  it('carries nothing else: the environment crosses a socket and is exported into a script', () => {
    // The daemon exports a build's env on the remote host, so a copied environment
    // would be a copied `AWS_TOKEN`. `spawnToLog` still gives the child this process's
    // environment for a local build, so nothing is lost by not sending it.
    const { env } = evalsBuildCommand({
      ...run,
      env: { PATH: '/usr/bin', GITHUB_TOKEN: 'secret', FLEET_EVALS_BIN: '/repo/bin/judge.ts' },
    })
    assert.deepEqual(env, { FLEET_EVAL_PROVIDER: 'claude', FLEET_EVAL_MODEL: 'a-model' })
  })

  it('lets FLEET_EVALS_BIN name the binary, and an explicit one win over it', () => {
    const env = { FLEET_EVALS_BIN: '/repo/bin/judge.ts' }
    assert.equal(evalsBuildCommand({ ...run, env }).bin, '/repo/bin/judge.ts')
    assert.equal(evalsBuildCommand({ ...run, env, bin: '/other/judge.ts' }).bin, '/other/judge.ts')
  })
})

describe('readEvalsAnswer: the file the ledger kept', () => {
  it('reads the answer the build left beside its log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-cli-evals-'))
    const answerPath = join(dir, 'run.out')
    await writeFile(answerPath, '{"runId":"evr_1"}\n')
    assert.equal(await readEvalsAnswer(answerPath, join(dir, 'run.log')), '{"runId":"evr_1"}\n')
  })

  it('names the log when there is no answer, because that is where the reason is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-cli-evals-'))
    await assert.rejects(
      () => readEvalsAnswer(join(dir, 'run.out'), join(dir, 'run.log')),
      (error: Error & { code?: string }) =>
        error.code === 'external_failed' &&
        error.message.includes('left no answer') &&
        error.message.includes(join(dir, 'run.log')),
    )
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
