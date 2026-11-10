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
})
