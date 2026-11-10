/**
 * `BranchHead` over a fake `git` (§6.2, §9). The whole point of the seam is that
 * this suite can prove the argv, the fetch-then-read order and the fail-soft
 * behaviour without a repository, a remote or a network.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBranchHead } from '../src/branch-head.ts'
import type { GitResult, GitRunner } from '../src/git.ts'

const checkout = '/tmp/fleet/acme-fleet'
const head = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'

interface Call {
  readonly args: readonly string[]
  readonly cwd: string
}

/** Replays canned results by the first argv word (`fetch`, `rev-parse`), and records every call. */
const fakeGit = (answers: Readonly<Record<string, GitResult>>): { runner: GitRunner; calls: Call[] } => {
  const calls: Call[] = []
  const runner: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd })
    return answers[args[0] ?? ''] ?? { code: 0, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' })
const failed = (stderr: string): GitResult => ({ code: 128, stdout: '', stderr })

describe('createBranchHead', () => {
  it('fetches origin/<branch> and reads the ref it names, in that order', async () => {
    const { runner, calls } = fakeGit({
      fetch: ok(''),
      'rev-parse': ok(`${head}\n`),
    })

    const sha = await createBranchHead(runner).head(checkout, 'main')

    assert.equal(sha, head)
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['fetch', '--quiet', 'origin', 'main'],
        ['rev-parse', 'origin/main'],
      ],
    )
    assert.ok(
      calls.every((call) => call.cwd === checkout),
      'every git call runs in the checkout it was asked about',
    )
  })

  it('reads through a failed fetch: the old ref is better than no scan', async () => {
    const { runner, calls } = fakeGit({
      fetch: failed('could not resolve host'),
      'rev-parse': ok(head),
    })

    const sha = await createBranchHead(runner).head(checkout, 'main')

    assert.equal(sha, head)
    assert.equal(calls.length, 2, 'the read still happens after the fetch fails')
  })

  it('is undefined, not a throw, when the ref cannot be read', async () => {
    const { runner } = fakeGit({
      fetch: failed('no such remote'),
      'rev-parse': failed('unknown revision origin/main'),
    })

    assert.equal(await createBranchHead(runner).head(checkout, 'main'), undefined)
  })

  it('refuses output that is not a commit sha', async () => {
    const { runner } = fakeGit({
      fetch: ok(''),
      'rev-parse': ok('not-a-sha\n'),
    })

    assert.equal(await createBranchHead(runner).head(checkout, 'main'), undefined)
  })

  it('reads the branch it is asked for, not a hard-coded main', async () => {
    const { runner, calls } = fakeGit({ fetch: ok(''), 'rev-parse': ok(head) })

    await createBranchHead(runner).head(checkout, 'release/1.x')

    assert.deepEqual(calls[1]?.args, ['rev-parse', 'origin/release/1.x'])
  })
})
