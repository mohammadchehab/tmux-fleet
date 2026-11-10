/**
 * The profile reader (§2): a hand-written file, read strictly, refused by name.
 *
 * These tests are about *refusals* more than successes. A profile that decodes
 * when it should not is the failure mode that matters — a fleet that starts with
 * a peer it should not have, or a key it silently ignored.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { decodeProfile, loadProfile, type Profile } from '../src/profile.ts'
import { profilePaths, parseProfileName, persistentDirs } from '../src/paths.ts'

const minimal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  profile: 'engineer',
  repos: ['backbase/me-services-fleet'],
  peers: [{ id: 'engineer-1', role: 'engineer', provider: 'claude', model: 'claude-sonnet-5-5' }],
  ...overrides,
})

const tempProfile = async (name: string, body: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-profile-'))
  const file = join(dir, `${name}.yaml`)
  await writeFile(file, body, 'utf8')
  return file
}

describe('the path layout', () => {
  it('keeps config and state apart, under the two roots the architecture fixed (§2)', () => {
    const paths = profilePaths('engineer', { home: '/home/u', configHome: '/cfg' })
    assert.equal(paths.profileFile, '/cfg/fleet/profiles/engineer.yaml')
    assert.equal(paths.stateDir, '/home/u/.fleet/engineer')
    assert.equal(paths.storePath, '/home/u/.fleet/engineer/store/store.sqlite')
    assert.equal(paths.socketPath, '/home/u/.fleet/engineer/daemon/fleetd.sock')
    assert.equal(paths.pidPath, '/home/u/.fleet/engineer/daemon/fleetd.pid')
    assert.equal(paths.logPath, '/home/u/.fleet/engineer/daemon/fleetd.log')
  })

  it('creates every directory a run writes into', () => {
    const paths = profilePaths('engineer', { home: '/home/u', configHome: '/cfg' })
    assert.deepEqual(persistentDirs(paths), [
      '/home/u/.fleet/engineer/store',
      '/home/u/.fleet/engineer/store/backup',
      '/home/u/.fleet/engineer/daemon',
      '/home/u/.fleet/engineer/peers',
      '/home/u/.fleet/engineer/transcripts',
      '/home/u/.fleet/engineer/artifacts',
      '/home/u/.fleet/engineer/artifacts/findings',
      '/home/u/.fleet/engineer/artifacts/builds',
      '/home/u/.fleet/engineer/notify',
    ])
  })

  it('refuses a name that would become a path', () => {
    for (const bad of ['../etc', 'Engineer', 'en gineer', '', '9lives', 'a/b']) {
      assert.throws(() => parseProfileName(bad), /is not a valid name/)
    }
    assert.equal(parseProfileName('engineer-2'), 'engineer-2')
  })
})

describe('decoding a profile', () => {
  it('reads the peers, the repos and the notice block', () => {
    const profile = decodeProfile(
      minimal({
        notify: { channel: 'macos' },
        limits: { maxSessions: 4 },
        routines: { standup: { at: '08:30' } },
        deleteMergedBranches: true,
      }),
    )
    assert.equal(profile.profile, 'engineer')
    assert.deepEqual(profile.repos, ['backbase/me-services-fleet'])
    assert.deepEqual(profile.peers, [
      { id: 'engineer-1', role: 'engineer', provider: 'claude', model: 'claude-sonnet-5-5' },
    ])
    assert.equal(profile.notify?.channel, 'macos')
    assert.equal(profile.deleteMergedBranches, true)
  })

  it('refuses a misspelt key rather than dropping it (§3, applied to config)', () => {
    assert.throws(() => decodeProfile(minimal({ delelteMergedBranches: true })), /unknown field/)
  })

  it('reads §6.2’s scanner set, and installs nothing when there is no block', () => {
    const profile = decodeProfile(minimal({ security: { scanners: ['semgrep', 'gitleaks'] } }))
    assert.deepEqual(profile.security?.scanners, ['semgrep', 'gitleaks'])
    assert.equal(decodeProfile(minimal()).security, undefined)
  })

  it('refuses a scanner it cannot build, and an empty set that would scan nothing', () => {
    assert.throws(() => decodeProfile(minimal({ security: { scanners: ['snyk'] } })), /snyk/)
    // An empty list would install the routine and then scan nothing, which reads
    // as coverage the fleet does not have.
    assert.throws(() => decodeProfile(minimal({ security: { scanners: [] } })), /at least one scanner/)
  })

  it('refuses a peer with no model: `peer.registered` carries one, so a default would be an invented policy', () => {
    assert.throws(
      () => decodeProfile(minimal({ peers: [{ id: 'engineer-1', role: 'engineer', provider: 'claude' }] })),
      /model/,
    )
  })

  it('refuses a peer id that is not a peer id, and a provider the daemon cannot build', () => {
    assert.throws(
      () => decodeProfile(minimal({ peers: [{ id: 'Engineer 1', role: 'e', provider: 'claude', model: 'm' }] })),
      /PeerId|peer/i,
    )
    assert.throws(
      () => decodeProfile(minimal({ peers: [{ id: 'engineer-1', role: 'e', provider: 'opencode', model: 'm' }] })),
      /claude|deepinfra/,
    )
  })
})

describe('loading the profile file', () => {
  it('reads YAML and insists the file name and the profile name agree', async () => {
    const file = await tempProfile(
      'engineer',
      `profile: engineer
repos: [backbase/me-services-fleet]
peers:
  - id: engineer-1
    role: engineer
    provider: claude
    model: claude-sonnet-5-5
    permissionMode: acceptEdits
`,
    )
    const profile = await loadProfile(file, 'engineer')
    assert.equal(profile.peers[0]?.permissionMode, 'acceptEdits')
  })

  it('refuses a file that names another profile', async () => {
    const file = await tempProfile('engineer', `profile: devops\nrepos: []\npeers:\n  - id: d-1\n    role: devops\n    provider: claude\n    model: m\n`)
    await assert.rejects(loadProfile(file, 'engineer'), /says `profile: devops`/)
  })

  it('refuses a profile with no peers, and two peers with one id', async () => {
    const empty = await tempProfile('engineer', 'profile: engineer\nrepos: []\npeers: []\n')
    await assert.rejects(loadProfile(empty, 'engineer'), /declares no peers/)

    const twice = await tempProfile(
      'engineer',
      `profile: engineer
repos: []
peers:
  - { id: engineer-1, role: a, provider: claude, model: m }
  - { id: engineer-1, role: b, provider: claude, model: m }
`,
    )
    await assert.rejects(loadProfile(twice, 'engineer'), /same peer id twice/)
  })

  it('says where the file should be when it is missing', async () => {
    await assert.rejects(loadProfile('/nope/engineer.yaml', 'engineer'), /no profile at \/nope\/engineer\.yaml/)
  })

  it('reports invalid YAML as the file it could not read', async () => {
    const file = await tempProfile('engineer', 'profile: [unclosed\n')
    await assert.rejects(loadProfile(file, 'engineer'), /is not valid YAML/)
  })
})
