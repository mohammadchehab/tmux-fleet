/**
 * The `Coordination` port over real `git`, against a local bare repository
 * standing in for the coordination repo (shared-fleet.md §2). Nothing here is
 * faked below the runner: the lease, the create-once race and the parentless
 * fleet branch are what git and its receive-pack actually do, which is the
 * property the design rests on — so a fake would test the wrong thing.
 *
 * Each "fleet" is its own transport with its own cache, as two laptops would be.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { FleetError, type Sha } from '@fleet/foundation-core'
import { createGitCoordination, execFileGit, type GitRunner } from '../src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'fleet-coord-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0

/** A fresh remote, as `git init --bare` makes one: nothing on it. */
const remote = (): string => {
  const path = join(root, `remote-${++counter}.git`)
  execFileSync('git', ['init', '--bare', '--quiet', path])
  return path
}

/** A runner that records every argv it passes to the real `git`. */
const recording = () => {
  const calls: string[][] = []
  const git: GitRunner = (args, call) => {
    calls.push([...args])
    return execFileGit(args, call)
  }
  return { calls, git }
}

const fleet = (repo: string, user: string, git?: GitRunner) =>
  createGitCoordination({
    remote: repo,
    cache: join(root, `cache-${++counter}-${user}`),
    author: { name: user, email: `${user}@users.noreply.github.com` },
    version: '0.0.0-test',
    ...(git === undefined ? {} : { git }),
  })

const onRemote = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['--git-dir', repo, ...args], { encoding: 'utf8' }).trim()

const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(promise, (thrown: unknown) => thrown instanceof FleetError && thrown.code === code)
}

describe('a fleet branch (publish, §2.1)', () => {
  it('is readable by another fleet once published, with the files as written', async () => {
    const repo = remote()
    const alice = fleet(repo, 'alice')
    const bob = fleet(repo, 'bob')
    const files = { 'pace.json': '{"pace":0.6}\n', heartbeat: '2026-11-10T21:00:00.000Z' }

    const sha = await alice.publish({ ref: 'eng-07/fleet/alice', files, expected: undefined, message: 'pace' })

    const [ref] = await bob.refs('eng-07/')
    assert.deepEqual(ref, { name: 'eng-07/fleet/alice', sha })
    assert.deepEqual(await bob.read(ref!), { sha, files })
  })

  it('is one parentless commit however often it is published', async () => {
    const repo = remote()
    const alice = fleet(repo, 'alice')
    let sha: Sha | undefined
    for (const pace of ['0.1', '0.2', '0.3']) {
      sha = await alice.publish({ ref: 'eng-07/fleet/alice', files: { pace }, expected: sha, message: 'pace' })
    }

    assert.equal(onRemote(repo, 'rev-list', '--count', 'refs/heads/eng-07/fleet/alice'), '1')
    assert.equal(onRemote(repo, 'show', `refs/heads/eng-07/fleet/alice:pace`), '0.3')
  })

  it('refuses a publish decided on a sha the remote no longer holds, and leaves the remote alone', async () => {
    const repo = remote()
    const laptop = fleet(repo, 'alice')
    const desktop = fleet(repo, 'alice')
    const first = await laptop.publish({ ref: 'eng-07/fleet/alice', files: { pace: '1' }, expected: undefined, message: 'm' })
    const second = await desktop.publish({ ref: 'eng-07/fleet/alice', files: { pace: '2' }, expected: first, message: 'm' })

    await rejectsWith(laptop.publish({ ref: 'eng-07/fleet/alice', files: { pace: '3' }, expected: first, message: 'm' }), 'head_moved')
    await rejectsWith(laptop.publish({ ref: 'eng-07/fleet/alice', files: { pace: '3' }, expected: undefined, message: 'm' }), 'head_moved')
    assert.equal(onRemote(repo, 'rev-parse', 'refs/heads/eng-07/fleet/alice'), second)
  })
})

describe('a create-once ref (create, §2.1)', () => {
  it('has exactly one winner among simultaneous creates, and every loser learns the winner', async () => {
    const repo = remote()
    const fleets = ['alice', 'bob', 'carol', 'dave'].map((user) => fleet(repo, user))

    const results = await Promise.all(
      fleets.map((f, i) => f.create({ ref: 'eng-07/claim/7f3a9c', files: { by: `fleet-${i}` }, message: 'claim' })),
    )

    const winners = results.filter((r) => r.created)
    assert.equal(winners.length, 1)
    const held = onRemote(repo, 'rev-parse', 'refs/heads/eng-07/claim/7f3a9c')
    assert.equal(winners[0]!.sha, held)
    for (const result of results) assert.equal(result.sha, held)
  })

  it('is not taken over by a later create', async () => {
    const repo = remote()
    const first = await fleet(repo, 'alice').create({ ref: 'eng-07/rotate/1', files: { n: '1' }, message: 'rotate' })
    const second = await fleet(repo, 'bob').create({ ref: 'eng-07/rotate/1', files: { n: '1' }, message: 'rotate' })

    assert.deepEqual(second, { created: false, sha: first.sha })
  })
})

describe('releasing a ref (release, §2.3)', () => {
  it('deletes a ref at the sha the caller saw', async () => {
    const repo = remote()
    const alice = fleet(repo, 'alice')
    const claim = await alice.create({ ref: 'eng-07/claim/a1', files: { by: 'alice' }, message: 'claim' })

    await fleet(repo, 'bob').release('eng-07/claim/a1', claim.sha)
    assert.deepEqual(await alice.refs(), [])
  })

  it('leaves a ref that was re-taken since, and says so', async () => {
    const repo = remote()
    const alice = fleet(repo, 'alice')
    const stale = await alice.create({ ref: 'eng-07/claim/a1', files: { by: 'alice' }, message: 'claim' })
    await alice.release('eng-07/claim/a1', stale.sha)
    const retaken = await fleet(repo, 'carol').create({ ref: 'eng-07/claim/a1', files: { by: 'carol' }, message: 'claim' })

    await rejectsWith(fleet(repo, 'bob').release('eng-07/claim/a1', stale.sha), 'head_moved')
    assert.equal(onRemote(repo, 'rev-parse', 'refs/heads/eng-07/claim/a1'), retaken.sha)
  })

  it('reports a ref that is already gone as not_found', async () => {
    const repo = remote()
    const alice = fleet(repo, 'alice')
    const claim = await alice.create({ ref: 'eng-07/claim/a1', files: {}, message: 'claim' })
    await alice.release('eng-07/claim/a1', claim.sha)

    await rejectsWith(alice.release('eng-07/claim/a1', claim.sha), 'not_found')
  })
})

describe('polling (refs and read, §2.2)', () => {
  it('lists every ref in one request and filters by prefix', async () => {
    const repo = remote()
    const alice = fleet(repo, 'alice')
    await alice.publish({ ref: 'eng-07/fleet/alice', files: {}, expected: undefined, message: 'm' })
    await alice.publish({ ref: 'eng-08/fleet/alice', files: {}, expected: undefined, message: 'm' })

    assert.equal((await alice.refs()).length, 2)
    assert.deepEqual((await alice.refs('eng-07/')).map((ref) => ref.name), ['eng-07/fleet/alice'])
  })

  it('fetches a ref once and reads it from the cache while it has not moved', async () => {
    const repo = remote()
    await fleet(repo, 'alice').publish({ ref: 'eng-07/fleet/alice', files: { pace: '1' }, expected: undefined, message: 'm' })
    const { calls, git } = recording()
    const bob = fleet(repo, 'bob', git)
    const [ref] = await bob.refs()

    await bob.read(ref!)
    await bob.read(ref!)

    assert.equal(calls.filter((argv) => argv.includes('fetch')).length, 1)
  })

  it('reads the newer commit when the ref moved after it was listed', async () => {
    const repo = remote()
    const alice = fleet(repo, 'alice')
    const bob = fleet(repo, 'bob')
    const first = await alice.publish({ ref: 'eng-07/fleet/alice', files: { pace: '1' }, expected: undefined, message: 'm' })
    const [listed] = await bob.refs()
    const second = await alice.publish({ ref: 'eng-07/fleet/alice', files: { pace: '2' }, expected: first, message: 'm' })

    assert.deepEqual(await bob.read(listed!), { sha: second, files: { pace: '2' } })
  })

  it('reads a ref deleted after it was listed as undefined', async () => {
    const repo = remote()
    const alice = fleet(repo, 'alice')
    const claim = await alice.create({ ref: 'eng-07/claim/a1', files: {}, message: 'claim' })
    const bob = fleet(repo, 'bob')
    const [listed] = await bob.refs()
    await alice.release('eng-07/claim/a1', claim.sha)

    assert.equal(await bob.read(listed!), undefined)
  })

  it('names itself to the network on every call that leaves the machine', async () => {
    const repo = remote()
    const { calls, git } = recording()
    const alice = fleet(repo, 'alice', git)
    await alice.publish({ ref: 'eng-07/fleet/alice', files: {}, expected: undefined, message: 'm' })
    const claim = await fleet(repo, 'bob').create({ ref: 'eng-07/claim/a1', files: {}, message: 'claim' })
    await alice.read({ name: 'eng-07/claim/a1', sha: claim.sha })
    await alice.refs()

    const verbs = ['push', 'fetch', 'ls-remote']
    const network = calls.filter((argv) => argv.some((arg) => verbs.includes(arg)))
    assert.deepEqual(new Set(network.map((argv) => argv.find((arg) => verbs.includes(arg)))), new Set(verbs))
    for (const argv of network) assert.deepEqual(argv.slice(0, 2), ['-c', 'http.userAgent=tmux-fleet/0.0.0-test (fleet-coord)'])
  })
})

describe('names', () => {
  for (const ref of ['', '-delete', 'eng-07/../main', 'eng-07//x', '.hidden/x', 'eng-07/x.lock', 'eng 07/x', 'refs/heads/x:y']) {
    it(`refuses the ref ${JSON.stringify(ref)} before running git`, async () => {
      const { calls, git } = recording()
      await rejectsWith(fleet(remote(), 'alice', git).create({ ref, files: {}, message: 'm' }), 'invalid_input')
      assert.deepEqual(calls, [])
    })
  }

  for (const file of ['../escape', 'dir/file', '-n', '']) {
    it(`refuses the file name ${JSON.stringify(file)} before running git`, async () => {
      const { calls, git } = recording()
      const publish = fleet(remote(), 'alice', git).publish({
        ref: 'eng-07/fleet/alice',
        files: { [file]: 'x' },
        expected: undefined,
        message: 'm',
      })
      await rejectsWith(publish, 'invalid_input')
      assert.deepEqual(calls, [])
    })
  }
})
