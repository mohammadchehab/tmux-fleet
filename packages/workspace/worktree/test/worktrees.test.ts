/**
 * `Worktrees` over a fake `git` (§9). What §9 asks of this adapter is narrow and
 * worth pinning down: it removes the path it was given, it removes it from the
 * repository that owns it (never from inside the checkout itself, which git
 * refuses), it never asks for `--force`, and it will not remove a path git does
 * not list as one of that repository's checkouts — the path comes from a
 * projection row, and a row is not an argument.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { GitResult, GitRunner } from '../src/git.ts'
import { createWorktrees } from '../src/worktrees.ts'

const path = '/repo/.claude/worktrees/fleet-work-1'

interface Call {
  readonly args: readonly string[]
  readonly cwd: string
}

/** Replays canned results by the first argv word (`rev-parse`, `worktree`), and records every call. */
const fakeGit = (answers: Readonly<Record<string, GitResult>>): { runner: GitRunner; calls: Call[] } => {
  const calls: Call[] = []
  const runner: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd })
    return answers[args[0] ?? ''] ?? { code: 0, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' })
const failed = (stderr: string): GitResult => ({ code: 128, stdout: '', stderr })

describe('createWorktrees', () => {
  it('asks git where the repository is, then removes the checkout from there', async () => {
    const { runner, calls } = fakeGit({
      'rev-parse': ok('/repo/.git\n'),
      worktree: ok(`worktree ${path}\n\nHEAD abc\n\nbranch refs/heads/main\n`),
    })

    await createWorktrees(runner).remove(path)

    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        ['worktree', 'list', '--porcelain'],
        ['worktree', 'remove', path],
      ],
    )
    // The removal must not run inside the checkout: git refuses to remove the
    // directory it is standing in, and that is exactly the path being removed.
    assert.equal(calls[0]?.cwd, path)
    assert.equal(calls[1]?.cwd, '/repo')
    assert.equal(calls[2]?.cwd, '/repo')
  })

  it('refuses a path git does not list as a checkout of this repository, and removes nothing', async () => {
    const { runner, calls } = fakeGit({
      'rev-parse': ok('/repo/.git\n'),
      // Another repository's checkout, or a plain directory: git has no such worktree.
      worktree: ok('worktree /repo\n\nHEAD abc\n\nbranch refs/heads/main\n'),
    })

    await assert.rejects(createWorktrees(runner).remove(path), {
      message: /is not a worktree \/repo has; nothing was removed/,
    })
    assert.ok(calls.every((call) => call.args[1] !== 'remove'))
  })

  it('refuses a relative path before it resolves against whatever cwd the daemon has', async () => {
    const { runner, calls } = fakeGit({})

    await assert.rejects(createWorktrees(runner).remove('.claude/worktrees/fleet-work-1'), {
      message: /is not an absolute path; no worktree was removed/,
    })
    assert.equal(calls.length, 0)
  })

  it('never forces: a checkout holding changes is git’s to refuse (§9)', async () => {
    const calls: Call[] = []
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === 'rev-parse') return ok('/repo/.git\n')
      if (args[1] === 'list') return ok(`worktree ${path}\n\nHEAD abc\n\nbranch refs/heads/main\n`)
      return failed(`fatal: '${path}' contains modified or untracked files, use --force to delete it`)
    }

    await assert.rejects(createWorktrees(runner).remove(path), {
      message: /git refused to remove the worktree .* contains modified or untracked files/,
    })
    assert.ok(calls.every((call) => call.args.every((arg) => arg !== '--force' && arg !== '-f')))
  })

  it('refuses a path git does not know as a worktree, without trying to remove it', async () => {
    const { runner, calls } = fakeGit({ 'rev-parse': failed('fatal: not a git repository') })

    await assert.rejects(createWorktrees(runner).remove('/tmp/not-a-worktree'), {
      message: /is not a worktree git knows: fatal: not a git repository/,
    })
    assert.equal(calls.length, 1)
  })

  it('refuses a repository whose git directory is not the usual `<repo>/.git`', async () => {
    // A bare repo, or a checkout whose `.git` is a file: the parent of the common
    // directory is still the directory to run from, and a slash-less answer is not
    // something to guess at.
    const { runner } = fakeGit({ 'rev-parse': ok('\n') })
    await assert.rejects(createWorktrees(runner).remove(path), { message: /named no common directory/ })
  })

  it('if the worktree directory is already deleted, prunes the registration anyway (TASK-34)', async () => {
    const { runner, calls } = fakeGit({
      'rev-parse': failed('fatal: cannot change to /repo/.claude/worktrees/fleet-work-1: No such file or directory'),
      worktree: ok(`worktree ${path}\n\nHEAD abc\n\nbranch refs/heads/main\n`),
    })

    // Should succeed and prune the registration, not throw ENOENT
    await createWorktrees(runner).remove(path)

    // Verify it called worktree remove despite rev-parse failing
    assert.ok(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove'))
  })

  it('creates a worktree at <checkout>/.claude/worktrees/<topic> on a fresh branch', async () => {
    let revParseCallCount = 0
    const runner: GitRunner = async (args, cwd) => {
      if (args[0] === 'rev-parse') {
        revParseCallCount++
        // First rev-parse: --show-toplevel (validation); Second: --abbrev-ref origin/HEAD
        return revParseCallCount === 1 ? ok('/repo\n') : ok('origin/main\n')
      }
      if (args[0] === 'worktree') return ok()
      if (args[0] === 'checkout') return ok()
      if (args[0] === 'push') return ok()
      return { code: 0, stdout: '', stderr: '' }
    }

    const result = await createWorktrees(runner).create({
      repo: 'owner/repo' as any,
      checkoutPath: '/repo',
      topic: 'fleet-work-1',
      workId: 'wrk_abc123',
    })

    assert.equal(result.path, '/repo/.claude/worktrees/fleet-work-1')
    assert.equal(result.branch, 'work-fleet-work-1')
  })

  it('rejects invalid topic slugs', async () => {
    const createRunner = () => {
      let revParseCallCount = 0
      const runner: GitRunner = async (args, cwd) => {
        if (args[0] === 'rev-parse') {
          revParseCallCount++
          return revParseCallCount === 1 ? ok('/repo\n') : ok('origin/main\n')
        }
        return { code: 0, stdout: '', stderr: '' }
      }
      return runner
    }

    const invalid = ['Topic', 'fleet_work', 'fleet-work-', '-fleet-work', '', 'a'.repeat(41)]
    for (const topic of invalid) {
      await assert.rejects(createWorktrees(createRunner()).create({
        repo: 'owner/repo' as any,
        checkoutPath: '/repo',
        topic,
        workId: 'wrk_abc123',
      }), {
        message: /invalid topic/,
      })
    }
  })

  it('accepts valid topic slugs: lowercase alphanumeric and hyphens, 1-40 chars', async () => {
    let revParseCallCount = 0
    const runner: GitRunner = async (args, cwd) => {
      if (args[0] === 'rev-parse') {
        revParseCallCount++
        return revParseCallCount === 1 ? ok('/repo\n') : ok('origin/main\n')
      }
      if (args[0] === 'worktree') return ok()
      if (args[0] === 'checkout') return ok()
      if (args[0] === 'push') return ok()
      return { code: 0, stdout: '', stderr: '' }
    }

    const valid = ['a', 'fleet-work-1', 'work', '1', 'abc-def-ghi-123']
    for (const topic of valid) {
      revParseCallCount = 0
      const result = await createWorktrees(runner).create({
        repo: 'owner/repo' as any,
        checkoutPath: '/repo',
        topic,
        workId: 'wrk_abc123',
      })
      assert.ok(result.path.includes(topic))
    }
  })

  it('cleans up the worktree if branch creation fails', async () => {
    let revParseCallCount = 0
    const calls: Call[] = []
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === 'rev-parse') {
        revParseCallCount++
        return revParseCallCount === 1 ? ok('/repo\n') : ok('origin/main\n')
      }
      if (args[0] === 'worktree') return ok()
      if (args[0] === 'checkout') return failed('ref already exists')
      return { code: 0, stdout: '', stderr: '' }
    }

    await assert.rejects(createWorktrees(runner).create({
      repo: 'owner/repo' as any,
      checkoutPath: '/repo',
      topic: 'fleet-work-1',
      workId: 'wrk_abc123',
    }), {
      message: /git refused to create branch/,
    })

    // Verify cleanup was attempted: worktree remove after checkout failed
    assert.ok(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove'))
  })

  it('cleans up the worktree if push fails', async () => {
    let revParseCallCount = 0
    const calls: Call[] = []
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === 'rev-parse') {
        revParseCallCount++
        return revParseCallCount === 1 ? ok('/repo\n') : ok('origin/main\n')
      }
      if (args[0] === 'worktree') return ok()
      if (args[0] === 'checkout') return ok()
      if (args[0] === 'push') return failed('failed to push')
      return { code: 0, stdout: '', stderr: '' }
    }

    await assert.rejects(createWorktrees(runner).create({
      repo: 'owner/repo' as any,
      checkoutPath: '/repo',
      topic: 'fleet-work-1',
      workId: 'wrk_abc123',
    }), {
      message: /git refused to push branch/,
    })

    // Verify cleanup was attempted: worktree remove after push failed
    assert.ok(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove'))
  })

  it('validates checkoutPath is absolute', async () => {
    const { runner } = fakeGit({})

    await assert.rejects(createWorktrees(runner).create({
      repo: 'owner/repo' as any,
      checkoutPath: 'relative/path',
      topic: 'fleet-work-1',
      workId: 'wrk_abc123',
    }), {
      message: /checkoutPath must be absolute/,
    })
  })

  it('validates checkoutPath does not contain ".."', async () => {
    const { runner } = fakeGit({})

    await assert.rejects(createWorktrees(runner).create({
      repo: 'owner/repo' as any,
      checkoutPath: '/repo/../other',
      topic: 'fleet-work-1',
      workId: 'wrk_abc123',
    }), {
      message: /checkoutPath must not contain "\.\."/,
    })
  })

  it('validates checkoutPath is a git repository', async () => {
    const { runner } = fakeGit({
      'rev-parse': failed('fatal: not a git repository'),
    })

    await assert.rejects(createWorktrees(runner).create({
      repo: 'owner/repo' as any,
      checkoutPath: '/invalid/repo/path',
      topic: 'fleet-work-1',
      workId: 'wrk_abc123',
    }), {
      message: /checkoutPath is not a git repository/,
    })
  })

  it('validates checkoutPath is the git repository root, not a subdirectory', async () => {
    const { runner } = fakeGit({
      'rev-parse': ok('/repo\n'),
    })

    await assert.rejects(createWorktrees(runner).create({
      repo: 'owner/repo' as any,
      checkoutPath: '/repo/subdir',
      topic: 'fleet-work-1',
      workId: 'wrk_abc123',
    }), {
      message: /must be the git repository root/,
    })
  })
})
