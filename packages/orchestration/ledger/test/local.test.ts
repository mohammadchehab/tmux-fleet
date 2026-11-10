/**
 * The local runner: it turns a build into one process, in the command's own
 * directory, logging where the ledger said. The process is faked, because the
 * point of the runner is the mapping and not `spawn`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLocalRunner } from '../src/local.ts'
import type { BuildRun, ProcessInvocation, ProcessOutcome } from '../src/runner.ts'
import { repo, sha } from './support/fakes.ts'

const run = (overrides: Partial<BuildRun> = {}): BuildRun => ({
  buildId: 'bld-1',
  repo: repo(),
  sha: sha(),
  task: 'test:unit',
  command: { bin: 'pnpm', args: ['test'], cwd: '/src/tmux-fleet', env: { CI: '1' } },
  logPath: '/logs/sha-test.log',
  ...overrides,
})

const recorder = (outcome: ProcessOutcome = { code: 0, durationMs: 12 }) => {
  const seen: ProcessInvocation[] = []
  return {
    seen,
    invoke: async (invocation: ProcessInvocation) => {
      seen.push(invocation)
      return outcome
    },
  }
}

describe('createLocalRunner', () => {
  it('serves the local host', () => {
    assert.equal(createLocalRunner().host, 'local')
  })

  it('runs the command as one process, in its own cwd, into the build log', async () => {
    const { seen, invoke } = recorder()
    const outcome = await createLocalRunner({ process: invoke }).run(run())

    assert.deepEqual(seen, [
      {
        file: 'pnpm',
        args: ['test'],
        env: { CI: '1' },
        cwd: '/src/tmux-fleet',
        logPath: '/logs/sha-test.log',
      },
    ])
    assert.deepEqual(outcome, { status: 'succeeded', durationMs: 12, exitCode: 0 })
  })

  it('reports a non-zero exit as a failed build, carrying the code', async () => {
    const { invoke } = recorder({ code: 2, durationMs: 5 })
    const outcome = await createLocalRunner({ process: invoke }).run(run())
    assert.deepEqual(outcome, { status: 'failed', durationMs: 5, exitCode: 2 })
  })

  it('reports a signal death as failed with no code', async () => {
    const { invoke } = recorder({ code: null, durationMs: 5 })
    const outcome = await createLocalRunner({ process: invoke }).run(run())
    assert.deepEqual(outcome, { status: 'failed', durationMs: 5, exitCode: null })
  })
})
