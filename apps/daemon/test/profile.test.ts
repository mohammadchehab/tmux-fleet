/**
 * The profile reader (§2): a hand-written file, read strictly, refused by name.
 *
 * The path layout it points at moved to `foundation/core` and is tested there;
 * what is left here is the file itself — reading it, and what it refuses.
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
