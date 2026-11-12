/**
 * `RepoFiles` (§12.1), against real git in temp repositories: what is pinned here
 * is that a file is read from the default branch's commit and never from a working
 * tree, which is the only reason this is not `readFile`.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { execFileGit } from '../src/git.ts'
import { createRepoFiles } from '../src/repo-files.ts'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

const dir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

/** An origin with `AGENTS.md` committed on main, and a clone of it with `origin/HEAD` set. */
const cloned = (): { readonly origin: string; readonly clone: string; readonly sha: string } => {
  const origin = dir('fleet-origin-')
  git(origin, 'init', '-q', '-b', 'main')
  writeFileSync(join(origin, 'AGENTS.md'), 'Reviewed rules.\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-q', '-m', 'rules')
  const clone = dir('fleet-clone-')
  git(clone, 'clone', '-q', origin, '.')
  git(clone, 'remote', 'set-head', 'origin', 'main')
  return { origin, clone, sha: git(origin, 'rev-parse', 'HEAD') }
}

describe('createRepoFiles', () => {
  it('reads the file at the default branch’s commit, and names that commit', async () => {
    const { clone, sha } = cloned()
    assert.deepEqual(await createRepoFiles().read(clone, 'AGENTS.md'), { text: 'Reviewed rules.\n', ref: sha })
  })

  it('does not see an edit in the working tree, committed or not on another branch: a peer cannot change its own rules', async () => {
    const { clone, sha } = cloned()
    writeFileSync(join(clone, 'AGENTS.md'), 'Rules I wrote for myself.\n')
    git(clone, 'checkout', '-q', '-b', 'peer/engineer-1')
    git(clone, 'commit', '-q', '-am', 'my own rules')
    writeFileSync(join(clone, 'AGENTS.md'), 'And uncommitted ones.\n')

    assert.deepEqual(await createRepoFiles().read(clone, 'AGENTS.md'), { text: 'Reviewed rules.\n', ref: sha })
  })

  it('reads from a worktree of the repository the same way', async () => {
    const { clone, sha } = cloned()
    const worktree = join(clone, '.claude/worktrees/peer-a')
    git(clone, 'worktree', 'add', '-q', '-b', 'peer/a', worktree)
    writeFileSync(join(worktree, 'AGENTS.md'), 'edited in the peer’s own tree\n')

    assert.deepEqual(await createRepoFiles().read(worktree, 'AGENTS.md'), { text: 'Reviewed rules.\n', ref: sha })
  })

  it('is nothing, not an error, when there is nothing to read: no such file, no default branch, not a repository', async () => {
    const { clone } = cloned()
    const files = createRepoFiles()
    assert.equal(await files.read(clone, 'CLAUDE.md'), undefined, 'the file is not on the branch')

    const fresh = dir('fleet-fresh-')
    git(fresh, 'init', '-q', '-b', 'main')
    writeFileSync(join(fresh, 'AGENTS.md'), 'local only\n')
    git(fresh, 'add', '.')
    git(fresh, 'commit', '-q', '-m', 'x')
    assert.equal(await files.read(fresh, 'AGENTS.md'), undefined, 'no origin: a local file is not the default branch’s')

    assert.equal(await files.read(dir('fleet-notrepo-'), 'AGENTS.md'), undefined)
    assert.equal(await files.read('/nonexistent/fleet-dir', 'AGENTS.md'), undefined)
  })

  it('refuses a path that is not inside the repository', async () => {
    const { clone } = cloned()
    for (const path of ['/etc/passwd', '../outside', 'a/../../b']) {
      await assert.rejects(createRepoFiles().read(clone, path), /not a path inside a repository/, path)
    }
  })

  it('reads what the remote says the branch is, so a peer that moves origin/main locally cannot rewrite its rules', async () => {
    const { clone, sha } = cloned()
    // The peer's tree is a worktree of the clone, and refs/remotes is shared.
    const worktree = join(clone, '.claude/worktrees/peer-a')
    git(clone, 'worktree', 'add', '-q', '-b', 'peer/a', worktree)
    writeFileSync(join(worktree, 'AGENTS.md'), 'Rules I wrote for myself.\n')
    git(worktree, 'commit', '-q', '-am', 'mine')
    git(worktree, 'update-ref', 'refs/remotes/origin/main', git(worktree, 'rev-parse', 'HEAD'))

    assert.deepEqual(await createRepoFiles().read(worktree, 'AGENTS.md'), { text: 'Reviewed rules.\n', ref: sha })
  })

  it('follows the remote forward too: a newer reviewed commit the clone has not fetched is the one read', async () => {
    const { origin, clone } = cloned()
    writeFileSync(join(origin, 'AGENTS.md'), 'Newer reviewed rules.\n')
    git(origin, 'commit', '-q', '-am', 'newer')
    const newer = git(origin, 'rev-parse', 'HEAD')

    assert.deepEqual(await createRepoFiles().read(clone, 'AGENTS.md'), { text: 'Newer reviewed rules.\n', ref: newer })
  })

  it('reads nothing when the remote cannot be reached: the local origin/main is peer-writable, so it is not silently trusted', async () => {
    const { origin, clone } = cloned()
    git(clone, 'remote', 'set-url', 'origin', join(origin, 'gone'))
    assert.equal(await createRepoFiles().read(clone, 'AGENTS.md'), undefined)
  })

  it('falls back to the local ref only when the caller opts in, and names it', async () => {
    const { origin, clone, sha } = cloned()
    git(clone, 'remote', 'set-url', 'origin', join(origin, 'gone'))
    assert.deepEqual(await createRepoFiles(undefined, { allowStaleLocal: true }).read(clone, 'AGENTS.md'), {
      text: 'Reviewed rules.\n',
      ref: sha,
    })
  })

  it('ignores url.*.insteadOf in the shared config: the standards cannot be fetched from another repository', async () => {
    const { origin, clone, sha } = cloned()
    const evil = dir('fleet-evil-')
    git(evil, 'init', '-q', '-b', 'main')
    writeFileSync(join(evil, 'AGENTS.md'), 'Evil rules.\n')
    git(evil, 'add', '.')
    git(evil, 'commit', '-q', '-m', 'evil')
    git(clone, 'config', `url.${evil}.insteadOf`, origin)

    assert.deepEqual(await createRepoFiles().read(clone, 'AGENTS.md'), { text: 'Reviewed rules.\n', ref: sha })
  })

  it('a pinned remoteUrl wins over a rewritten remote.origin.url', async () => {
    const { origin, clone, sha } = cloned()
    const evil = dir('fleet-evil-')
    git(evil, 'init', '-q', '-b', 'main')
    writeFileSync(join(evil, 'AGENTS.md'), 'Evil rules.\n')
    git(evil, 'add', '.')
    git(evil, 'commit', '-q', '-m', 'evil')
    git(clone, 'remote', 'set-url', 'origin', evil)

    assert.deepEqual(await createRepoFiles(undefined, { remoteUrl: origin }).read(clone, 'AGENTS.md'), {
      text: 'Reviewed rules.\n',
      ref: sha,
    })
  })

  it('runs network git outside the shared repository, with transport keys pinned', async () => {
    const { origin, clone } = cloned()
    const calls: { args: readonly string[]; cwd: string }[] = []
    const files = createRepoFiles(async (args, cwd) => {
      calls.push({ args, cwd })
      return execFileGit(args, cwd)
    })
    await files.read(clone, 'AGENTS.md')
    const net = calls.filter((c) => c.args.includes('fetch'))
    assert.equal(net.length, 1)
    assert.notEqual(net[0]?.cwd, clone)
    assert.ok(net[0]?.args.includes('core.sshCommand=ssh'))
    assert.ok(net[0]?.args.includes(origin))
  })
})
