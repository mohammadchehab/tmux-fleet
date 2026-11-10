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
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    assert.ok(script.includes(`git worktree add --quiet --detach "$tree" 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'`))
  })

  it('builds in its own tree, never in the repo directory, and removes it however it ends', () => {
    const add = lines.findIndex((line) => line.startsWith('git worktree add'))
    assert.ok(lines.findIndex((line) => line.startsWith('tree=$(mktemp -d')) < add)
    assert.ok(lines.findIndex((line) => line.startsWith('trap ') && line.includes('EXIT')) < add, 'armed before the tree exists')
    assert.equal(lines[add + 1], 'cd "$tree"')
  })

  it('carries the command env as exports', () => {
    assert.ok(script.includes(`export MODEL='opus'`))
  })

  it("puts the tree's own bins ahead of the host's, after the checkout", () => {
    // A workspace bin is only on PATH in the tree that installed it, and the tree
    // is not there until the checkout above has run.
    const path = lines.findIndex((line) => line.startsWith('export PATH='))
    assert.ok(path > lines.findIndex((line) => line.startsWith('git worktree add')))
    assert.equal(lines[path], `export PATH="$tree/node_modules/.bin":"$PATH"`)
  })

  it('installs from the tree’s own lockfile, with the output kept off the answer', () => {
    assert.ok(script.includes('pnpm install --frozen-lockfile --silent >&2'))
  })

  it('runs the command last, each argument quoted, and does not exec past the cleanup trap', () => {
    assert.equal(lines.at(-1), `'pnpm' 'evals' 'run' 'judge'`)
    assert.ok(!script.includes('exec '), 'exec would skip the trap that removes the tree')
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

describe('remoteScript on a real repository (TASK-96)', () => {
  // The script is what ssh hands the remote shell, so `sh -c` runs it here as it would
  // there. One clone under the root, as the host keeps it, and a bare origin to fetch from.
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim()

  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-remote-'))
    const origin = join(dir, 'origin.git')
    const seed = join(dir, 'seed')
    const root = join(dir, 'root')
    mkdirSync(root)
    git(dir, 'init', '--bare', '-b', 'main', origin)
    git(dir, 'clone', '-q', origin, seed)
    git(seed, 'config', 'user.email', 't@t')
    git(seed, 'config', 'user.name', 't')
    writeFileSync(join(seed, 'marker'), 'one')
    git(seed, 'add', '.')
    git(seed, 'commit', '-qm', 'one')
    const first = git(seed, 'rev-parse', 'HEAD')
    writeFileSync(join(seed, 'marker'), 'two')
    git(seed, 'commit', '-qam', 'two')
    const second = git(seed, 'rev-parse', 'HEAD')
    git(seed, 'push', '-q', 'origin', 'main')
    git(root, 'clone', '-q', origin, join(root, 'acme-widgets'))
    return { dir, root, first, second, clone: join(root, 'acme-widgets') }
  }

  const run = (root: string, sha: string, bin: string, args: string[]): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const script = remoteScript({ root, remote: 'origin' }, { repo: 'acme/widgets', sha, command: { bin, args } })
      execFile('sh', ['-c', script], { encoding: 'utf8' }, (error, stdout) =>
        resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), out: stdout.trim() }),
      )
    })

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('builds the sha it was asked for even while another build checks out a different one', async () => {
    const { dir, root, first, second } = fixture()
    try {
      // The first build is still running when the second one starts and moves "the" tree.
      const slow = run(root, first, 'sh', ['-c', 'sleep 1; git rev-parse HEAD; cat marker'])
      await pause(300)
      const quick = run(root, second, 'sh', ['-c', 'git rev-parse HEAD; cat marker'])
      const [a, b] = await Promise.all([slow, quick])

      assert.equal(a.out, `${first}\none`, 'a build describes the commit it was keyed on')
      assert.equal(b.out, `${second}\ntwo`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts every build from a clean tree and leaves nothing behind', async () => {
    const { dir, root, second, clone } = fixture()
    try {
      const dirty = await run(root, second, 'sh', ['-c', 'touch left-behind; git status --porcelain'])
      assert.equal(dirty.out, '?? left-behind')

      const next = await run(root, second, 'sh', ['-c', 'ls; git status --porcelain'])
      assert.equal(next.out, 'marker', 'a file one build left is not in the next build’s tree')

      assert.equal(git(clone, 'worktree', 'list').split('\n').length, 1, 'the build’s worktree is removed afterwards')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes the worktree and keeps the exit code when the build fails', async () => {
    const { dir, root, second, clone } = fixture()
    try {
      const failed = await run(root, second, 'sh', ['-c', 'exit 7'])
      assert.equal(failed.code, 7)
      assert.equal(git(clone, 'worktree', 'list').split('\n').length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
