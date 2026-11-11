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
import { execSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitResult, GitRunner } from '../src/git.ts'
import { execFileGit } from '../src/git.ts'
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
/** `git show-ref --verify --quiet`: 1 is "no such ref", which is what a fresh topic answers. */
const absent = (): GitResult => ({ code: 1, stdout: '', stderr: '' })

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
      if (args[0] === 'show-ref') return absent()
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
      if (args[0] === 'show-ref') return absent()
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
      if (args[0] === 'show-ref') return absent()
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
    // ...and the branch goes with it, from the repository (the checkout is gone
    // by then), so the name is free for the retry (TASK-60).
    const deleted = calls.find((call) => call.args[0] === 'branch' && call.args[1] === '-D')
    assert.deepEqual(deleted?.args, ['branch', '-D', 'work-fleet-work-1'])
    assert.equal(deleted?.cwd, '/repo')
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
      if (args[0] === 'show-ref') return absent()
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
    // The branch the push was about goes too, or the next create dies on its name
    // (TASK-60).
    const deleted = calls.find((call) => call.args[0] === 'branch' && call.args[1] === '-D')
    assert.deepEqual(deleted?.args, ['branch', '-D', 'work-fleet-work-1'])
    assert.equal(deleted?.cwd, '/repo')
  })

  it('refuses a branch that is already taken before it creates a checkout (TASK-60)', async () => {
    const calls: Call[] = []
    let revParseCallCount = 0
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === 'rev-parse') {
        revParseCallCount++
        return revParseCallCount === 1 ? ok('/repo\n') : ok('origin/main\n')
      }
      // The leftover a failed create used to leave behind.
      if (args[0] === 'show-ref') return ok()
      return { code: 0, stdout: '', stderr: '' }
    }

    await assert.rejects(createWorktrees(runner).create({
      repo: 'owner/repo' as any,
      checkoutPath: '/repo',
      topic: 'fleet-work-1',
      workId: 'wrk_abc123',
    }), {
      message: /branch work-fleet-work-1 already exists/,
    })

    // Refused before anything was made: a checkout created only to be torn down
    // would be a second failure path to keep honest.
    assert.ok(!calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'))
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

  it('removes a worktree even if its directory was already deleted (TASK-59: real git repo)', async () => {
    // Create a temporary git repository
    const tmpDir = mkdtempSync(join(tmpdir(), 'fleet-worktree-test-'))
    try {
      // Initialize a bare repo as the "remote" and a normal repo as the main checkout
      const remoteDir = join(tmpDir, 'remote.git')
      const repoDir = join(tmpDir, 'repo')

      // Pin the branch: the runner's git defaults to `master`, so a fixture that relies on the
      // ambient init.defaultBranch names no branch the test can check out or push.
      execSync(`git init --bare --initial-branch=main ${remoteDir}`)
      execSync(`git clone ${remoteDir} ${repoDir}`)

      // Create a commit so HEAD is valid
      execSync(`cd ${repoDir} && git config user.email "test@example.com" && git config user.name "Test"`)
      execSync(`cd ${repoDir} && echo "test" > file.txt && git add file.txt && git commit -m "test commit"`)
      execSync(`cd ${repoDir} && git push -u origin HEAD:refs/heads/main`, { stdio: 'pipe' })

      // Create a worktree using the current commit (detached)
      const worktreeDir = join(repoDir, '.claude', 'worktrees', 'task-59')
      execSync(`cd ${repoDir} && git worktree add --detach ${worktreeDir} HEAD`, {
        stdio: 'pipe',
      })

      // Verify the worktree exists
      const listBefore = execSync(`cd ${repoDir} && git worktree list --porcelain`, {
        encoding: 'utf8',
      })
      assert.ok(listBefore.includes(worktreeDir), 'worktree should be listed before deletion')

      // Delete the worktree directory
      rmSync(worktreeDir, { recursive: true, force: true })

      // Now try to remove it via the Worktrees adapter
      // This should succeed by inferring the repo path and running `git worktree remove`
      await createWorktrees(execFileGit).remove(worktreeDir)

      // Verify the worktree is no longer listed
      const listAfter = execSync(`cd ${repoDir} && git worktree list --porcelain`, {
        encoding: 'utf8',
      })
      assert.ok(!listAfter.includes(worktreeDir), 'worktree should not be listed after removal')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('a create() that fails after making its branch leaves no branch behind (TASK-60: real git repo)', async () => {
    // realpath'd: create() refuses a checkoutPath that is a symlink, and on macOS
    // the temp directory itself is one (`/var` -> `/private/var`).
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-worktree-test-')))
    try {
      const remoteDir = join(tmpDir, 'remote.git')
      const repoDir = join(tmpDir, 'repo')

      execSync(`git init --bare --initial-branch=main ${remoteDir}`)
      execSync(`git clone ${remoteDir} ${repoDir}`)
      execSync(`cd ${repoDir} && git config user.email "test@example.com" && git config user.name "Test"`)
      execSync(`cd ${repoDir} && echo "test" > file.txt && git add file.txt && git commit -m "test commit"`)
      execSync(`cd ${repoDir} && git push -u origin HEAD:refs/heads/main`, { stdio: 'pipe' })
      // `origin/HEAD` is where create() reads its base from. Set it rather than ask
      // the server with `remote set-head -a`: a bare repo's own HEAD still names the
      // branch `git init` picked, which was never pushed, so the server cannot answer
      // — and what `git init` picks differs between this machine and CI.
      execSync(`cd ${repoDir} && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`, {
        stdio: 'pipe',
      })

      // An origin that refuses pushes, as an unreachable or protecting remote does.
      // The failure lands after the branch exists, which is the whole point.
      const hook = join(remoteDir, 'hooks', 'pre-receive')
      writeFileSync(hook, '#!/bin/sh\necho "push rejected by the test" >&2\nexit 1\n', { mode: 0o755 })

      const input = {
        repo: 'owner/repo' as any,
        checkoutPath: repoDir,
        topic: 'task-60',
        workId: 'wrk_abc123',
      }
      const worktrees = createWorktrees(execFileGit)

      await assert.rejects(worktrees.create(input), { message: /git refused to push branch/ })

      // The checkout is torn down, and the branch it was on with it: a call that
      // failed leaves the repository as it found it, so the name is free again.
      const branches = execSync('git branch --list work-task-60', { cwd: repoDir, encoding: 'utf8' }).trim()
      assert.equal(branches, '', 'a failed create must not leave work-task-60 behind')
      const checkouts = execSync('git worktree list --porcelain', { cwd: repoDir, encoding: 'utf8' })
      assert.ok(!checkouts.includes(join(repoDir, '.claude', 'worktrees', 'task-60')))

      // With origin accepting pushes again, the retry — the thing the leak blocked —
      // gets further than `checkout -b`.
      rmSync(hook)
      const created = await worktrees.create(input)
      assert.equal(created.branch, 'work-task-60')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
