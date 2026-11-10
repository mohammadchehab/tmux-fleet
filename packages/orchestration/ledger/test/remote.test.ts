/**
 * The remote runner (§11): one `ssh`, a script that pins the sha, and the same
 * log a local build writes.
 *
 * The assertions are on the script's text rather than on a remote box, because
 * the script *is* the contract with the host: the sha pin is what makes
 * `(repo, sha, task)` true (a build of the branch head would make the key a
 * lie), and the quoting is what keeps an argument an argument.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRemoteRunner, remoteArgv, remoteRepoDir, remoteScript, shellQuote } from '../src/remote.ts'
import type { BuildRun, ProcessInvocation, ProcessOutcome } from '../src/runner.ts'
import { repo, sha } from './support/fakes.ts'

const options = { target: 'hetzner', root: '/srv/fleet' }

const build = (overrides: Partial<BuildRun> = {}): BuildRun => ({
  buildId: 'bld-1',
  repo: repo(),
  sha: sha(),
  task: 'evals:judge:claude:opus',
  command: { bin: 'pnpm', args: ['evals', 'run', 'judge'], env: { MODEL: 'opus' } },
  logPath: '/logs/sha-evals.log',
  stdoutPath: '/logs/sha-evals.out',
  ...overrides,
})

describe('shellQuote', () => {
  it('quotes an argument so nothing in it is syntax', () => {
    assert.equal(shellQuote('plain'), `'plain'`)
    assert.equal(shellQuote("it's"), `'it'\\''s'`)
    assert.equal(shellQuote('a; rm -rf /'), `'a; rm -rf /'`)
  })
})

describe('remoteRepoDir', () => {
  it('is one flat directory per repo', () => {
    assert.equal(remoteRepoDir('backbase/me-services-fleet'), 'backbase-me-services-fleet')
  })

  it('cannot climb out of the root', () => {
    // No `/` survives the slug, so no `..` in the result is a path segment.
    const dir = remoteRepoDir('../../etc')
    assert.equal(dir, '..-..-etc')
    assert.ok(!dir.includes('/'))
  })
})

describe('remoteScript', () => {
  const script = remoteScript(options, build())
  const lines = script.split('\n')

  it('stops at the first failure, in the repo it was asked for', () => {
    assert.equal(lines[0], 'set -e')
    assert.equal(lines[1], `cd '/srv/fleet/backbase-me-services-fleet'`)
  })

  it('pins the sha, which is what the ledger keyed the build on', () => {
    assert.ok(lines[2]?.includes(`'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'`))
    assert.equal(lines[3], `git checkout --quiet --detach 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'`)
  })

  it('carries the command env as exports', () => {
    assert.ok(script.includes(`export MODEL='opus'`))
  })

  it("puts the checkout's own bins ahead of the host's, after the checkout", () => {
    // A workspace bin is only on PATH in the tree that installed it, and the tree
    // is not there until the checkout above has run.
    const path = lines.findIndex((line) => line.startsWith('export PATH='))
    assert.ok(path > lines.findIndex((line) => line.startsWith('git checkout')))
    assert.equal(lines[path], `export PATH='/srv/fleet/backbase-me-services-fleet/node_modules/.bin':"$PATH"`)
  })

  it('execs the command, each argument quoted', () => {
    assert.equal(lines.at(-1), `exec 'pnpm' 'evals' 'run' 'judge'`)
  })

  it('execs, so the remote shell exits with the build', () => {
    // Exactly one `exec`, and it is the last line: anything after it would be a
    // second command, and `exec` would never reach it.
    assert.equal(script.match(/exec /g)?.length, 1)
  })

  it('takes the remote name from the profile', () => {
    const named = remoteScript({ ...options, remote: 'upstream' }, build())
    assert.ok(named.includes(`'upstream'`))
  })
})

describe('remoteArgv', () => {
  it('cannot prompt, cannot hang, and passes the script as one argument', () => {
    const argv = remoteArgv('hetzner', 'set -e')
    assert.deepEqual(argv, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', 'hetzner', '--', 'set -e'])
  })
})

describe('createRemoteRunner', () => {
  const recorder = (outcome: ProcessOutcome = { code: 0, durationMs: 900 }) => {
    const seen: ProcessInvocation[] = []
    return {
      seen,
      invoke: async (invocation: ProcessInvocation) => {
        seen.push(invocation)
        return outcome
      },
    }
  }

  it('serves the remote host', () => {
    assert.equal(createRemoteRunner(options).host, 'remote')
  })

  it('runs one ssh into the build log', async () => {
    const { seen, invoke } = recorder()
    const outcome = await createRemoteRunner({ ...options, process: invoke }).run(build())

    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.file, 'ssh')
    assert.deepEqual(seen[0]?.args, remoteArgv('hetzner', remoteScript(options, build())))
    assert.equal(seen[0]?.logPath, '/logs/sha-evals.log')
    // ssh keeps the remote's streams apart, so the answer file is filled on this side.
    assert.equal(seen[0]?.stdoutPath, '/logs/sha-evals.out')
    assert.deepEqual(outcome, { status: 'succeeded', durationMs: 900, exitCode: 0 })
  })

  it('reports a failed remote build as failed, with its code', async () => {
    const { invoke } = recorder({ code: 255, durationMs: 30 })
    const outcome = await createRemoteRunner({ ...options, process: invoke }).run(build())
    assert.deepEqual(outcome, { status: 'failed', durationMs: 30, exitCode: 255 })
  })
})
