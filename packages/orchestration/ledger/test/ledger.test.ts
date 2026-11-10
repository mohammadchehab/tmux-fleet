/**
 * §11, as tests: one build per `(repo, sha, task)`, the existing result for the
 * second caller, and heavy tasks on the remote host.
 *
 * The store and the projection are fakes (`support/fakes.ts`), because §11's
 * promise is about *the log*: a test that re-ran a real build would be testing
 * `pnpm`, and a test that asserted on a return value alone could not tell "ran
 * once" from "ran twice and both said the same thing". So the assertions read
 * the appended events.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixedClock, fleetError } from '@fleet/foundation-core'
import type { BuildId, PeerId } from '@fleet/foundation-core'
import { createBuildLedger, type BuildLedger, type BuildRequest } from '../src/ledger.ts'
import type { BuildRun, BuildRunner, BuildRunResult } from '../src/runner.ts'
import { fakeBuilds, fakeStore, repo, sha } from './support/fakes.ts'

const at = fixedClock('2026-11-10T10:00:00.000Z')

/** A runner that records what it was asked to run and answers with a fixed result. */
const fakeRunner = (host: BuildRunner['host'], result: BuildRunResult = { status: 'succeeded', durationMs: 42, exitCode: 0 }) => {
  const runs: BuildRun[] = []
  const runner: BuildRunner = {
    host,
    async run(build) {
      runs.push(build)
      return result
    },
  }
  return { runner, runs }
}

const request = (overrides: Partial<BuildRequest> = {}): BuildRequest => ({
  repo: repo(),
  sha: sha(),
  task: 'test:unit',
  command: { bin: 'pnpm', args: ['test'] },
  ...overrides,
})

const setup = (
  options: {
    readonly heavy?: readonly string[]
    readonly requestedBy?: string
    readonly remote?: BuildRunner
    readonly local?: BuildRunner
    readonly logDir?: string
  } = {},
) => {
  const store = fakeStore()
  const builds = fakeBuilds(store)
  const local = fakeRunner('local')
  const remote = fakeRunner('remote')
  let next = 0
  const ledger: BuildLedger = createBuildLedger({
    store,
    builds,
    routing: { host: 'local', heavy: options.heavy ?? [] },
    runners: {
      local: options.local ?? local.runner,
      remote: options.remote ?? remote.runner,
    },
    logDir: options.logDir ?? '/logs',
    clock: at,
    mintBuildId: () => `bld-${String((next += 1))}` as BuildId,
  })
  return { store, builds, ledger, local, remote }
}

describe('the build ledger', () => {
  it('runs a light task locally and records both events', async () => {
    const { store, ledger, local } = setup()
    const outcome = await ledger.request(request())

    assert.equal(outcome.deduped, false)
    assert.equal(outcome.build.status, 'succeeded')
    assert.equal(outcome.build.host, 'local')
    assert.equal(local.runs.length, 1)

    // The runner is told where the log goes and where the answer goes beside it:
    // a build that answers with data (§17's eval run) does not have to derive a
    // path the ledger already decided.
    assert.deepEqual(local.runs, [
      {
        buildId: 'bld-1',
        repo: repo(),
        sha: sha(),
        task: 'test:unit',
        command: { bin: 'pnpm', args: ['test'] },
        logPath: '/logs/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678-test-unit.log',
        stdoutPath: '/logs/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678-test-unit.out',
      },
    ])

    const [requested] = store.ofType('build.requested')
    assert.deepEqual(requested?.data, {
      buildId: 'bld-1',
      repo: repo(),
      sha: sha(),
      task: 'test:unit',
      host: 'local',
    })
    assert.equal(requested?.ts, '2026-11-10T10:00:00.000Z')
    assert.equal(requested?.subject, 'bld-1')
    // No `requestedBy` is a routine's request, which §3 logs as the scheduler's.
    assert.equal(requested?.actor, 'scheduler')

    const [finished] = store.ofType('build.finished')
    assert.deepEqual(finished?.data, {
      buildId: 'bld-1',
      repo: repo(),
      sha: sha(),
      task: 'test:unit',
      status: 'succeeded',
      logPath: '/logs/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678-test-unit.log',
      durationMs: 42,
    })
  })

  it("attributes a peer's request to the peer (§3)", async () => {
    const { store, ledger } = setup()
    await ledger.request(request({ requestedBy: 'eng-1' as PeerId }))

    const [requested] = store.ofType('build.requested')
    assert.equal(requested?.actor, 'peer:eng-1')
    assert.equal(requested?.data.requestedBy, 'eng-1')
  })

  it('answers a second request for the same key with the first result, and appends nothing', async () => {
    const { store, ledger, local } = setup()
    const first = await ledger.request(request())
    const second = await ledger.request(request())

    assert.equal(local.runs.length, 1)
    assert.equal(second.deduped, true)
    assert.equal(second.build.buildId, first.build.buildId)
    assert.equal(store.ofType('build.requested').length, 1)
    assert.equal(store.ofType('build.finished').length, 1)
  })

  it('treats a different sha or task as a different build', async () => {
    const { store, ledger, local } = setup()
    await ledger.request(request())
    await ledger.request(request({ sha: sha('b'.repeat(40)) }))
    await ledger.request(request({ task: 'test:e2e' }))

    assert.equal(local.runs.length, 3)
    assert.equal(store.ofType('build.requested').length, 3)
  })

  it('runs once when identical requests arrive together', async () => {
    const { ledger, local } = setup()
    const [a, b] = await Promise.all([ledger.request(request()), ledger.request(request())])

    assert.equal(local.runs.length, 1)
    // Both callers get the same answer; the second one is the deduped one only
    // when it was answered by the store, which here it was not — it awaited the
    // first caller's run, and that is what "never runs twice" means.
    assert.equal(a.build.buildId, b.build.buildId)
  })

  it('routes a heavy class to the remote host and runs it there', async () => {
    const { store, ledger, local, remote } = setup({ heavy: ['evals'] })
    const outcome = await ledger.request(request({ task: 'evals:judge:claude:opus' }))

    assert.equal(outcome.build.host, 'remote')
    assert.equal(remote.runs.length, 1)
    assert.equal(local.runs.length, 0)
    assert.equal(store.ofType('build.requested')[0]?.data.host, 'remote')
  })

  it('records a failed build as failed, with its exit code kept out of the event', async () => {
    const failing = fakeRunner('local', { status: 'failed', durationMs: 7, exitCode: 1 })
    const { store, ledger } = setup({ local: failing.runner })
    const outcome = await ledger.request(request())

    assert.equal(outcome.build.status, 'failed')
    assert.equal(store.ofType('build.finished')[0]?.data.status, 'failed')
    assert.equal(store.ofType('build.finished')[0]?.data.durationMs, 7)
  })

  it('records a runner that threw as a failed build, never a row stuck at running', async () => {
    const throwing: BuildRunner = {
      host: 'local',
      async run() {
        throw new Error('spawn ENOENT')
      },
    }
    const { store, ledger, builds } = setup({ local: throwing })
    const outcome = await ledger.request(request())

    assert.equal(outcome.build.status, 'failed')
    assert.equal(store.ofType('build.finished').length, 1)
    // The projection's row is what a retry reads: `running` there would be a
    // promise no second request would ever keep.
    assert.equal((await builds.get('bld-1'))?.status, 'failed')
  })

  it('reclaims a stale running row under the same build id', async () => {
    const { store, ledger } = setup()
    // A daemon that died mid-build leaves `build.requested` and no `finished`.
    await store.append([
      {
        type: 'build.requested',
        ts: at.now(),
        subject: 'bld-stale' as BuildId,
        actor: 'scheduler',
        data: { buildId: 'bld-stale', repo: repo(), sha: sha(), task: 'test:unit', host: 'local' },
      },
    ])

    const outcome = await ledger.request(request())

    assert.equal(outcome.build.buildId, 'bld-stale')
    assert.equal(outcome.build.status, 'succeeded')
    assert.equal(store.ofType('build.requested').length, 2)
  })

  it('refuses a task with no class to route on', async () => {
    const { ledger } = setup()
    await assert.rejects(ledger.request(request({ task: '' })), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'invalid_input')
      return true
    })
  })

  it('refuses a routing that names a remote host it cannot reach, when it is built', () => {
    assert.throws(
      () =>
        createBuildLedger({
          store: fakeStore(),
          builds: fakeBuilds(fakeStore()),
          routing: { host: 'local', heavy: ['evals'] },
          runners: { local: fakeRunner('local').runner },
          logDir: '/logs',
        }),
      (error: Error & { code?: string }) => error.code === 'invalid_input',
    )
  })

  it('reports where a task would run without running it', () => {
    const { ledger } = setup({ heavy: ['evals'] })
    assert.equal(ledger.hostFor('evals:judge:claude:opus'), 'remote')
    assert.equal(ledger.hostFor('test:unit'), 'local')
  })

  it('puts the log where the artifacts directory says', async () => {
    const { store, ledger } = setup({ logDir: '/home/fleet/.fleet/dev/artifacts/builds' })
    await ledger.request(request({ task: 'evals:judge:claude:opus' }))

    assert.equal(
      store.ofType('build.finished')[0]?.data.logPath,
      '/home/fleet/.fleet/dev/artifacts/builds/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678-evals-judge-claude-opus.log',
    )
  })

  it('does not leave a failed request holding the key', async () => {
    const { ledger, local } = setup()
    await assert.rejects(ledger.request(request({ task: '' })), /task/)
    // The next request for a good key runs: a coalescing map that kept the
    // rejection would make one typo poison the key forever.
    await ledger.request(request())
    assert.equal(local.runs.length, 1)
  })

  it('surfaces a store that refuses the event rather than running the build', async () => {
    const { store, ledger, local } = setup()
    store.failNext(fleetError('internal', 'disk full'))
    await assert.rejects(ledger.request(request()), /disk full/)
    assert.equal(local.runs.length, 0)
  })
})
