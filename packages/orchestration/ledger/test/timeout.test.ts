/**
 * A build that hangs must end (TASK-67). #192 gave `spawnToLog` a `timeoutMs`, but
 * neither runner passed one, so a hung `pnpm` or `ssh` never settled and every
 * request coalesced onto its key (`inFlight`) waited on it for ever. The tests here
 * are about the two halves of the fix together: the runners carry a real default, and
 * a build that overruns is killed *and* its waiters are released with a failed build.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fixedClock } from '@fleet/foundation-core'
import { createBuildLedger } from '../src/ledger.ts'
import { createLocalRunner } from '../src/local.ts'
import { createRemoteRunner } from '../src/remote.ts'
import { DEFAULT_BUILD_TIMEOUT_MS, type ProcessInvocation } from '../src/runner.ts'
import { fakeBuilds, fakeStore, repo, sha } from './support/fakes.ts'

const recorded = () => {
  const seen: ProcessInvocation[] = []
  return { seen, process: async (invocation: ProcessInvocation) => (seen.push(invocation), { code: 0, durationMs: 1 }) }
}

const run = {
  buildId: 'bld-1',
  repo: repo(),
  sha: sha(),
  task: 'evals:judge',
  command: { bin: 'pnpm', args: ['test'] },
  logPath: '/logs/a.log',
  stdoutPath: '/logs/a.out',
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the runners carry a timeout', () => {
  it('gives the local runner a real default, and lets the caller change it', async () => {
    const plain = recorded()
    await createLocalRunner({ process: plain.process }).run(run)
    assert.equal(plain.seen[0]?.timeoutMs, DEFAULT_BUILD_TIMEOUT_MS)
    assert.ok(DEFAULT_BUILD_TIMEOUT_MS > 0 && Number.isFinite(DEFAULT_BUILD_TIMEOUT_MS))

    const own = recorded()
    await createLocalRunner({ process: own.process, timeoutMs: 5_000 }).run(run)
    assert.equal(own.seen[0]?.timeoutMs, 5_000)
  })

  it('gives the remote runner the same, so a hung ssh or a hung remote build ends', async () => {
    const plain = recorded()
    await createRemoteRunner({ target: 'hetzner', root: '/srv/fleet', process: plain.process }).run(run)
    assert.equal(plain.seen[0]?.timeoutMs, DEFAULT_BUILD_TIMEOUT_MS)

    const own = recorded()
    await createRemoteRunner({ target: 'hetzner', root: '/srv/fleet', process: own.process, timeoutMs: 9_000 }).run(run)
    assert.equal(own.seen[0]?.timeoutMs, 9_000)
  })
})

describe('a hung build', () => {
  it('is killed with everything it started, and every request waiting on it is released as failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-timeout-'))
    const pidFile = join(dir, 'child.pid')
    const store = fakeStore()
    const ledger = createBuildLedger({
      store,
      builds: fakeBuilds(store),
      routing: { host: 'local', heavy: [] },
      runners: { local: createLocalRunner({ timeoutMs: 400 }) },
      logDir: join(dir, 'logs'),
      clock: fixedClock('2026-11-10T10:00:00.000Z'),
    })
    // A shell that starts a grandchild and waits on it: killing only the shell leaves the sleep.
    const request = {
      repo: repo(),
      sha: sha(),
      task: 'test:hang',
      command: { bin: 'sh', args: ['-c', `sleep 60 & echo $! > ${pidFile}; wait`] },
    }

    const started = Date.now()
    const outcomes = await Promise.race([
      Promise.all([ledger.request(request), ledger.request(request), ledger.request(request)]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the waiters were never released')), 10_000)),
    ])

    assert.ok(Date.now() - started < 8_000)
    assert.equal(store.ofType('build.finished').length, 1, 'one build, one verdict, however many asked')
    for (const outcome of outcomes) assert.equal(outcome.build.status, 'failed')

    const grandchild = Number((await readFile(pidFile, 'utf8')).trim())
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(alive(grandchild), false, 'the process group is killed, not only its leader')

    const log = await readFile(outcomes[0]?.build.logPath ?? '', 'utf8')
    assert.match(log, /timed out after 400ms/, 'the log says why the build ended')
  })
})
