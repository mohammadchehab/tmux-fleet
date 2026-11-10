/**
 * The engagement key's rotations (shared-fleet.md §5): one per change in the
 * team, sealed to the members as they stand, raced for and won by one fleet,
 * and never made when the team cannot really be read.
 *
 * The directory and the wrap are fakes that record what they were asked; the
 * sealing itself is `age`'s, tested with the real binary in
 * `@fleet/integrations-coordination`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ROTATION_FILE, type KeyWrap, type TeamDirectory } from '@fleet/foundation-contracts'
import { reconcileKey, type KeyReconcileOptions } from '../src/index.ts'
import { fakeCoordination, manualClock } from './support/fakes.ts'

const ED = (who: string) => `ssh-ed25519 AAAA${who}`

/** A team the test edits, and the keys each login has on GitHub. */
const fakeTeam = (members: string[], keys: Record<string, string[]>) => {
  const state = { members, keys, reads: 0 }
  const directory: TeamDirectory = {
    members: async () => {
      state.reads++
      return [...state.members].sort()
    },
    sshKeys: async (user) => state.keys[user] ?? [],
  }
  return { state, directory }
}

/** "Seals" by naming the key and the recipients, so a test can read who a copy was for. */
const fakeWrap = (): KeyWrap & { readonly sealed: { key: string; to: readonly string[] }[] } => {
  const sealed: { key: string; to: readonly string[] }[] = []
  return {
    sealed,
    recipient: (key) => (key.startsWith('ssh-ed25519 ') || key.startsWith('ssh-rsa ') ? key : undefined),
    wrap: async (key, to) => {
      sealed.push({ key, to })
      return `sealed(${key})->${to.join(',')}`
    },
    unwrap: async () => assert.fail('phase 1 never opens a copy'),
  }
}

const setup = (members = ['alice', 'bob'], keys: Record<string, string[]> = { alice: [ED('a')], bob: [ED('b'), 'ecdsa-sha2-nistp256 AAAAx'] }) => {
  const coordination = fakeCoordination()
  const team = fakeTeam(members, keys)
  const wrap = fakeWrap()
  let n = 0
  const options = (self = 'alice'): KeyReconcileOptions => ({
    coordination,
    directory: team.directory,
    wrap,
    namespace: 'eng-07',
    team: 'backbase-se/eng-07',
    self,
    clock: manualClock('2026-11-16T00:00:00.000Z').clock,
    newKey: () => `key-${++n}`,
  })
  return { coordination, team, wrap, options }
}

const filesOf = async (coordination: ReturnType<typeof fakeCoordination>, rotation: number) => {
  const [ref] = await coordination.refs(`eng-07/rotate/${rotation}`)
  return (await coordination.read(ref!))!.files
}

describe('the first fleet up in an engagement', () => {
  it('makes rotation 1, with one copy per member sealed to their usable keys, and the record', async () => {
    const { coordination, wrap, options } = setup()

    assert.deepEqual(await reconcileKey(options()), { kind: 'rotated', rotation: 1, members: ['alice', 'bob'], missing: [] })

    const files = await filesOf(coordination, 1)
    assert.deepEqual(Object.keys(files).sort(), ['alice.age', 'bob.age', ROTATION_FILE])
    assert.deepEqual(wrap.sealed, [
      { key: 'key-1', to: [ED('a')] },
      { key: 'key-1', to: [ED('b')] },
    ], 'one key, sealed per member, to the key types age can use')
    assert.deepEqual(JSON.parse(files[ROTATION_FILE]!), {
      version: 1,
      rotation: 1,
      members: ['alice', 'bob'],
      missing: [],
      by: 'alice',
      at: '2026-11-16T00:00:00.000Z',
    })
    assert.ok(!files[ROTATION_FILE]!.includes('key-1'), 'the record never carries the key')
  })
})

describe('a team that has not changed', () => {
  it('keeps its rotation, and seals nothing', async () => {
    const { coordination, wrap, options } = setup()
    await reconcileKey(options())
    wrap.sealed.length = 0

    assert.deepEqual(await reconcileKey(options('bob')), { kind: 'current', rotation: 1 })
    assert.deepEqual(wrap.sealed, [])
    assert.equal((await coordination.refs('eng-07/rotate/')).length, 1)
  })
})

describe('a change in the team', () => {
  it('is a new key for the members who remain when someone leaves, with no copy for the leaver', async () => {
    const { coordination, team, wrap, options } = setup(['alice', 'bob', 'carol'], { alice: [ED('a')], bob: [ED('b')], carol: [ED('c')] })
    await reconcileKey(options())
    team.state.members = ['alice', 'bob']
    wrap.sealed.length = 0

    assert.deepEqual(await reconcileKey(options('bob')), { kind: 'rotated', rotation: 2, members: ['alice', 'bob'], missing: [] })
    assert.deepEqual(Object.keys(await filesOf(coordination, 2)).sort(), ['alice.age', 'bob.age', ROTATION_FILE])
    assert.ok(wrap.sealed.every((copy) => copy.key === 'key-2'), 'a new key, not the one the leaver held')
  })

  it('is a new key when someone joins, so the newcomer never holds one used before they joined', async () => {
    const { coordination, team, wrap, options } = setup()
    await reconcileKey(options())
    team.state.members = ['alice', 'bob', 'dave']
    team.state.keys['dave'] = [ED('d')]
    wrap.sealed.length = 0

    assert.equal((await reconcileKey(options())).kind, 'rotated')
    assert.deepEqual(wrap.sealed.find((copy) => copy.to.includes(ED('d'))), { key: 'key-2', to: [ED('d')] })
    assert.ok(!wrap.sealed.some((copy) => copy.key === 'key-1'))
    assert.deepEqual(Object.keys(await filesOf(coordination, 2)).sort(), ['alice.age', 'bob.age', 'dave.age', ROTATION_FILE])
  })

  it('records a member with no usable key as missing, and rotates once they add one', async () => {
    const { coordination, team, options } = setup(['alice', 'bob'], { alice: [ED('a')], bob: ['ecdsa-sha2-nistp256 AAAAx'] })

    assert.deepEqual(await reconcileKey(options()), { kind: 'rotated', rotation: 1, members: ['alice', 'bob'], missing: ['bob'] })
    assert.deepEqual(Object.keys(await filesOf(coordination, 1)).sort(), ['alice.age', ROTATION_FILE])
    assert.deepEqual(await reconcileKey(options()), { kind: 'current', rotation: 1 }, 'a member still without a key is not a change')

    team.state.keys['bob'] = [ED('b')]
    assert.deepEqual(await reconcileKey(options()), { kind: 'rotated', rotation: 2, members: ['alice', 'bob'], missing: [] })
  })

  it('is made by exactly one of the fleets that saw it', async () => {
    const { coordination, team, options } = setup(['alice', 'bob', 'carol'], { alice: [ED('a')], bob: [ED('b')], carol: [ED('c')] })
    await reconcileKey(options())
    team.state.members = ['alice', 'bob']

    const outcomes = await Promise.all([reconcileKey(options('alice')), reconcileKey(options('bob'))])

    assert.deepEqual(outcomes.map((o) => o.kind).sort(), ['lost_race', 'rotated'])
    assert.equal((await coordination.refs('eng-07/rotate/')).length, 2)
  })

  it('reads a rotation whose record does not decode as stale, and supersedes it', async () => {
    const { coordination, options } = setup()
    coordination.force('eng-07/rotate/1', { [ROTATION_FILE]: '{"version":2}' })

    assert.equal((await reconcileKey(options())).kind, 'rotated')
    assert.equal(JSON.parse((await filesOf(coordination, 2))[ROTATION_FILE]!).rotation, 2)
  })

  it('takes the highest rotation as current, by number and not by name', async () => {
    const { coordination, options } = setup()
    for (const n of [1, 2, 10]) {
      coordination.force(`eng-07/rotate/${n}`, {
        [ROTATION_FILE]: JSON.stringify({ version: 1, rotation: n, members: ['alice', 'bob'], missing: [], by: 'alice', at: '2026-11-01T00:00:00.000Z' }),
      })
    }
    coordination.force('eng-07/rotate/007', { [ROTATION_FILE]: 'not a rotation number' })

    assert.deepEqual(await reconcileKey(options()), { kind: 'current', rotation: 10 })
  })
})

describe('a team that cannot really be read', () => {
  it('rotates nobody out when the team reads as empty', async () => {
    const { coordination, team, options } = setup()
    await reconcileKey(options())
    team.state.members = []

    assert.equal((await reconcileKey(options())).kind, 'refused')
    assert.equal((await coordination.refs('eng-07/rotate/')).length, 1)
  })

  it('does not decide the key for a team its own user is not on', async () => {
    const { coordination, options } = setup()
    assert.equal((await reconcileKey(options('mallory'))).kind, 'refused')
    assert.deepEqual(await coordination.refs(), [])
  })

  it('makes no rotation when no member has a key age can use', async () => {
    const { coordination, options } = setup(['alice', 'bob'], { alice: ['ecdsa-sha2-nistp256 AAAAx'] })
    assert.equal((await reconcileKey(options())).kind, 'refused')
    assert.deepEqual(await coordination.refs(), [])
  })
})
