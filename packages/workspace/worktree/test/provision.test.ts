/**
 * `WorktreeProvisioner` (§9), against real git in a temp repository: what is
 * pinned here is what git does with the argv, which a fake cannot say.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createWorktreeProvisioner } from '../src/provision.ts'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

/** A repository with one commit on `main`, standing in for a profile's checkout. */
const repo = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-wt-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'first')
  return root
}

describe('createWorktreeProvisioner', () => {
  it('makes <repo>/.claude/worktrees/<topic> on a new branch, and the shared checkout stays where it was', async () => {
    const root = repo()
    const made = await createWorktreeProvisioner().ensure({ root, topic: 'peer-engineer-1', branch: 'peer/engineer-1' })

    assert.deepEqual(made, { path: join(root, '.claude/worktrees/peer-engineer-1'), created: true })
    assert.equal(git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'peer/engineer-1')
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the checkout was not switched')
  })

  it('is idempotent: a second ask for the same topic reuses the checkout and says so', async () => {
    const root = repo()
    const provisioner = createWorktreeProvisioner()
    const first = await provisioner.ensure({ root, topic: 'peer-a', branch: 'peer/a' })
    const again = await provisioner.ensure({ root, topic: 'peer-a', branch: 'peer/a' })

    assert.equal(again.path, first.path)
    assert.equal(again.created, false)
  })

  it('asked from inside a worktree, still makes a sibling under the owning repo, not a nested one', async () => {
    const root = repo()
    const provisioner = createWorktreeProvisioner()
    const first = await provisioner.ensure({ root, topic: 'peer-a', branch: 'peer/a' })
    const second = await provisioner.ensure({ root: first.path, topic: 'peer-b', branch: 'peer/b' })

    assert.equal(second.path, join(root, '.claude/worktrees/peer-b'))
  })

  it('reuses a branch that already exists instead of failing on -b', async () => {
    const root = repo()
    git(root, 'branch', 'peer/c')
    const made = await createWorktreeProvisioner().ensure({ root, topic: 'peer-c', branch: 'peer/c' })
    assert.equal(git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'peer/c')
  })

  it('refuses a branch another checkout already holds, rather than moving it', async () => {
    const root = repo()
    const provisioner = createWorktreeProvisioner()
    await provisioner.ensure({ root, topic: 'peer-a', branch: 'peer/shared' })
    await assert.rejects(provisioner.ensure({ root, topic: 'peer-b', branch: 'peer/shared' }), /git refused to make the worktree/)
    assert.equal(existsSync(join(root, '.claude/worktrees/peer-b')), false)
  })

  it('refuses a topic that is not one path segment, and a root that is not absolute or not a repo', async () => {
    const root = repo()
    const provisioner = createWorktreeProvisioner()
    for (const topic of ['../escape', 'a/b', '', '.hidden', '..']) {
      await assert.rejects(provisioner.ensure({ root, topic, branch: 'x' }), /not a worktree topic/, topic)
    }
    await assert.rejects(provisioner.ensure({ root: 'relative', topic: 'a', branch: 'x' }), /not an absolute path/)
    await assert.rejects(
      provisioner.ensure({ root: mkdtempSync(join(tmpdir(), 'fleet-notrepo-')), topic: 'a', branch: 'x' }),
      /not a repository git knows/,
    )
  })

  it('starts a new branch at the remote’s default branch, not at what the shared checkout has checked out', async () => {
    const root = repo()
    const origin = repo()
    git(root, 'remote', 'add', 'origin', origin)
    git(root, 'fetch', '-q', 'origin')
    git(root, 'remote', 'set-head', 'origin', 'main')
    git(root, 'checkout', '-q', '-b', 'someone-elses-topic')
    git(root, 'commit', '-q', '--allow-empty', '-m', 'unrelated work')

    const made = await createWorktreeProvisioner().ensure({ root, topic: 'peer-d', branch: 'peer/d' })

    assert.equal(git(made.path, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'))
    assert.notEqual(git(made.path, 'rev-parse', 'HEAD'), git(root, 'rev-parse', 'HEAD'))
  })

  it('leaves the shared checkout’s git status clean: a repo that does not ignore .claude/worktrees gets a local exclude', async () => {
    const root = repo()
    const provisioner = createWorktreeProvisioner()
    await provisioner.ensure({ root, topic: 'peer-a', branch: 'peer/a' })
    await provisioner.ensure({ root, topic: 'peer-b', branch: 'peer/b' })

    // Without the exclude this is `?? .claude/`, and a careless `git add -A` commits two checkouts.
    assert.equal(git(root, 'status', '--porcelain'), '')
    const exclude = readFileSync(join(root, '.git/info/exclude'), 'utf8')
    assert.equal(exclude.split('\n').filter((line) => line === '/.claude/worktrees/').length, 1, 'added once, not per peer')
  })

  it('does not touch the exclude file of a repo that already ignores the path, nor any tracked file', async () => {
    const root = repo()
    writeFileSync(join(root, '.gitignore'), '.claude/worktrees/\n')
    git(root, 'add', '.gitignore')
    git(root, 'commit', '-q', '-m', 'ignore worktrees')
    const before = readFileSync(join(root, '.git/info/exclude'), 'utf8')

    await createWorktreeProvisioner().ensure({ root, topic: 'peer-a', branch: 'peer/a' })

    assert.equal(readFileSync(join(root, '.git/info/exclude'), 'utf8'), before)
    assert.equal(git(root, 'status', '--porcelain'), '')
  })

  it('appends on its own line when the exclude file has no trailing newline, keeping what was there', async () => {
    const root = repo()
    writeFileSync(join(root, '.git/info/exclude'), '*.log')

    await createWorktreeProvisioner().ensure({ root, topic: 'peer-a', branch: 'peer/a' })

    assert.equal(readFileSync(join(root, '.git/info/exclude'), 'utf8'), '*.log\n/.claude/worktrees/\n')
  })

  it('repairs a checkout that already exists but was never excluded, on the idempotent path too', async () => {
    const root = repo()
    git(root, 'worktree', 'add', '-q', '-b', 'peer/a', join(root, '.claude/worktrees/peer-a'))
    assert.match(git(root, 'status', '--porcelain'), /\.claude/)

    const again = await createWorktreeProvisioner().ensure({ root, topic: 'peer-a', branch: 'peer/a' })

    assert.equal(again.created, false)
    assert.equal(git(root, 'status', '--porcelain'), '')
  })
})
