/**
 * The shared fleet's loop, as the daemon wires it (shared-fleet.md §2.2, §3):
 * the real git transport against a local bare repository standing in for
 * `fleet-coord`, the real publisher, and a store read the test controls.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { FleetError, type Clock, type PeerId, type Timestamp } from '@fleet/foundation-core'
import { FLEET_PACE_FILE, ROTATION_FILE, type MonthSpend, type Peer, type ReadModel, type TeamDirectory } from '@fleet/foundation-contracts'
import { createGh, type GhRunner } from '@fleet/integrations-github'
import { ageRecipient, createAgeKeyWrap, createGitCoordination } from '@fleet/integrations-coordination'
import type { PacePublisher } from '@fleet/orchestration-coordination'
import { coordinationFor, createCoordinationLoop, githubLogin, keyOutcomeLine } from '../src/routines/coordination.ts'

const root = mkdtempSync(join(tmpdir(), 'fleet-coord-daemon-'))
after(() => rmSync(root, { recursive: true, force: true }))

const clock: Clock = { now: () => '2026-11-16T00:00:00.000Z' as Timestamp, millis: () => Date.parse('2026-11-16T00:00:00.000Z') }

const read = (spentUsd: number): Pick<ReadModel, 'tokens' | 'peers'> => {
  const peers: readonly Peer[] = [
    {
      peerId: 'engineer-1' as PeerId,
      role: 'engineer',
      providerId: 'claude-code' as Peer['providerId'],
      model: 'claude-sonnet-5-5',
      permissionMode: 'acceptEdits',
      briefVersion: 1,
      state: 'idle',
      registeredAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ]
  return {
    tokens: { all: async () => [], month: async (month): Promise<MonthSpend> => ({ month, costUsd: spentUsd, turns: 1, unpricedTurns: 0 }) },
    peers: { all: async () => peers, get: async () => undefined },
  }
}

/** Timers a test fires by hand. */
const manualTimers = () => {
  const callbacks = new Map<number, () => void>()
  let next = 0
  return {
    callbacks,
    timers: {
      setInterval: (callback: () => void) => {
        callbacks.set(++next, callback)
        return next
      },
      clearInterval: (handle: unknown) => {
        callbacks.delete(handle as number)
      },
    },
  }
}

describe('a fleet in an engagement', () => {
  it('publishes its pace on <engagement>/fleet/<user> in the coordination repository', async () => {
    const remote = join(root, 'fleet-coord.git')
    execFileSync('git', ['init', '--bare', '--quiet', remote])
    const loop = await coordinationFor({
      coord: { engagement: 'eng-07', team: 'backbase-se/eng-07', repo: 'backbase-se/fleet-coord' },
      capUsd: 300,
      paths: { stateDir: join(root, 'state') },
      read: read(150),
      clock,
      login: async () => 'mohammads_backbase',
      coordination: createGitCoordination({
        remote,
        cache: join(root, 'cache.git'),
        author: { name: 'mohammads_backbase', email: 'mohammads_backbase@users.noreply.github.com' },
        version: 'test',
      }),
    })

    await loop.tick()

    assert.equal(loop.ref, 'eng-07/fleet/mohammads_backbase')
    const published = JSON.parse(
      execFileSync('git', ['--git-dir', remote, 'show', `refs/heads/${loop.ref}:${FLEET_PACE_FILE}`], { encoding: 'utf8' }),
    ) as Record<string, unknown>
    assert.equal(published['pace'], 1)
    assert.deepEqual(published['capacity'], [{ role: 'engineer', idle: 1 }])
  })

  it('takes the branch name from `coord.user` without asking gh', async () => {
    const loop = await coordinationFor({
      coord: { engagement: 'eng-07', team: 'o/t', repo: 'o/r', user: 'alice' },
      capUsd: 300,
      paths: { stateDir: join(root, 'unused') },
      read: read(0),
      clock,
      login: async () => assert.fail('a profile that names its user is not asked again'),
    })
    assert.equal(loop.ref, 'eng-07/fleet/alice')
  })
})

describe('the GitHub login', () => {
  const gh = (stdout: string, code = 0) => {
    const runner: GhRunner = async () => ({ code, stdout, stderr: code === 0 ? '' : 'not logged in' })
    return createGh(runner)
  }

  it('is what gh is signed in as', async () => {
    assert.equal(await githubLogin(gh('mohammads_backbase\n')), 'mohammads_backbase')
  })

  it('refuses fleet up with the remedy when gh has no login, or prints something that is not one', async () => {
    for (const answer of [gh('', 1), gh('{"message":"Bad credentials"}\n'), gh('alice/../main\n')]) {
      await assert.rejects(githubLogin(answer), (e: unknown) => e instanceof FleetError && e.code === 'invalid_input' && /coord\.user/.test(e.message))
    }
  })
})

describe('the loop', () => {
  const publisher = (behaviour: () => Promise<void>): PacePublisher & { calls: number } => {
    const p = {
      calls: 0,
      async tick() {
        p.calls++
        await behaviour()
        return { pace: {} as never, published: true, sha: '0'.repeat(40) as never }
      },
    }
    return p
  }

  it('looks once at start and then on every interval, until it is stopped', async () => {
    const p = publisher(async () => {})
    const { callbacks, timers } = manualTimers()
    const loop = createCoordinationLoop({ ref: 'eng-07/fleet/alice', publisher: p, timers })

    loop.start()
    await loop.tick()
    assert.equal(p.calls, 1, 'the start tick, joined by the explicit one')
    for (const fire of callbacks.values()) fire()
    await loop.tick()
    assert.equal(p.calls, 2)

    loop.stop()
    assert.equal(callbacks.size, 0)
  })

  it('reports a failed tick and keeps going, because a quiet fleet is not a fleet that is down', async () => {
    const errors: unknown[] = []
    let fail = true
    const p = publisher(async () => {
      if (fail) throw new Error('network is unreachable')
    })
    const loop = createCoordinationLoop({ ref: 'r', publisher: p, timers: manualTimers().timers, onError: (e) => errors.push(e) })

    await loop.tick()
    fail = false
    await loop.tick()

    assert.equal(errors.length, 1)
    assert.equal(p.calls, 2)
  })

  it('never runs two ticks at once, so a slow push is not raced by its own next tick', async () => {
    let release!: () => void
    const p = publisher(() => new Promise<void>((resolve) => (release = resolve)))
    const loop = createCoordinationLoop({ ref: 'r', publisher: p, timers: manualTimers().timers })

    const first = loop.tick()
    const second = loop.tick()
    release()
    await Promise.all([first, second])

    assert.equal(p.calls, 1)
  })
})

const has = (binary: string): boolean => {
  try {
    execFileSync('which', [binary], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('the engagement key, as the daemon runs it', () => {
  it('is made at start for the team, and the member’s copy opens with their own SSH key', { skip: has('age') ? false : 'needs age' }, async () => {
    const remote = join(root, 'keys.git')
    execFileSync('git', ['init', '--bare', '--quiet', remote])
    const identity = join(root, 'id_alice')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', identity])
    const directory: TeamDirectory = {
      members: async () => ['alice'],
      sshKeys: async () => [readFileSync(`${identity}.pub`, 'utf8').trim()],
    }
    const coordination = createGitCoordination({
      remote,
      cache: join(root, 'keys-cache.git'),
      author: { name: 'alice', email: 'alice@users.noreply.github.com' },
      version: 'test',
    })
    const loop = await coordinationFor({
      coord: { engagement: 'eng-07', team: 'backbase-se/eng-07', repo: 'backbase-se/fleet-coord', user: 'alice' },
      capUsd: 300,
      paths: { stateDir: root },
      read: read(0),
      clock,
      coordination,
      directory,
    })

    await loop.checkKey()

    const show = (path: string) => execFileSync('git', ['--git-dir', remote, 'show', `refs/heads/eng-07/rotate/1:${path}`], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(show(ROTATION_FILE)).members, ['alice'])
    const key = await createAgeKeyWrap({ cwd: root }).unwrap(show('alice.age'), identity)
    assert.equal(Buffer.from(key, 'base64').length, 32, 'a 32-byte key, base64, opened with the SSH key alice signs in with')
    assert.ok(ageRecipient(readFileSync(`${identity}.pub`, 'utf8')) !== undefined)

    await loop.checkKey()
    assert.equal(
      execFileSync('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/eng-07/rotate/'], { encoding: 'utf8' }).trim(),
      'refs/heads/eng-07/rotate/1',
      'the same team is the same key',
    )
  })

  it('looks at the key once at start and on its own interval, and reports a failure without stopping', async () => {
    const outcomes: string[] = []
    const errors: unknown[] = []
    let fail = false
    const { callbacks, timers } = manualTimers()
    const loop = createCoordinationLoop({
      ref: 'eng-07/fleet/alice',
      publisher: { tick: async () => ({ pace: {} as never, published: false, sha: '0'.repeat(40) as never }) },
      timers,
      onError: (e) => errors.push(e),
      keys: {
        reconcile: async () => {
          if (fail) throw new Error('gh: HTTP 502')
          return { kind: 'current', rotation: 3 }
        },
        onOutcome: (o) => outcomes.push(o.kind),
      },
    })

    loop.start()
    await loop.checkKey()
    assert.deepEqual(outcomes, ['current'])
    assert.equal(callbacks.size, 2, 'the pace and the key each have a timer')

    fail = true
    await loop.checkKey()
    assert.equal(errors.length, 1)

    loop.stop()
    assert.equal(callbacks.size, 0)
  })

  it('logs a rotation and a refusal, and stays quiet when nothing changed', () => {
    const ref = 'eng-07/fleet/alice'
    assert.equal(keyOutcomeLine(ref, { kind: 'current', rotation: 2 }), undefined)
    assert.equal(keyOutcomeLine(ref, { kind: 'lost_race', rotation: 2 }), undefined)
    assert.match(keyOutcomeLine(ref, { kind: 'rotated', rotation: 2, members: ['alice', 'bob'], missing: ['bob'] })!, /rotation 2 for 2 member\(s\); no copy for bob, who has no ssh-ed25519/)
    assert.match(keyOutcomeLine(ref, { kind: 'refused', reason: 'backbase-se/eng-07 reads as empty' })!, /not rotated: backbase-se\/eng-07 reads as empty/)
  })
})
