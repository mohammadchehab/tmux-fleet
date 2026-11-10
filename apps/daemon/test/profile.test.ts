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

  it('reads §10’s forge: no block is github.com, and a GitLab profile names its own host', () => {
    assert.equal(decodeProfile(minimal()).forge, undefined)
    const gitlab = decodeProfile(minimal({ forge: { kind: 'gitlab', host: 'rhl11374ap.ncbnpr.local' } }))
    assert.deepEqual(gitlab.forge, { kind: 'gitlab', host: 'rhl11374ap.ncbnpr.local' })
    // A public GitLab is the same profile with no host: `glab` then uses its own default.
    assert.deepEqual(decodeProfile(minimal({ forge: { kind: 'gitlab' } })).forge, { kind: 'gitlab' })
  })

  it('refuses a forge it cannot reach, and a host that is a URL instead of a hostname', () => {
    assert.throws(() => decodeProfile(minimal({ forge: { kind: 'bitbucket' } })), /bitbucket/)
    // `GITLAB_HOST` takes a bare host; a pasted URL is a host no `glab` subcommand recognises.
    assert.throws(
      () => decodeProfile(minimal({ forge: { kind: 'gitlab', host: 'https://gitlab.example' } })),
      /bare hostname/,
    )
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

  it('reads §3’s tracker block, and installs nothing when there is no block', () => {
    const profile = decodeProfile(
      minimal({
        trackers: {
          system: 'backlog',
          query: 'To Do,In Progress',
          statuses: { in_progress: 'In Progress', in_review: 'In Review' },
          path: './board',
          urlBase: 'https://github.com/acme/widgets/blob/main',
          role: 'engineer',
        },
      }),
    )
    assert.deepEqual(profile.trackers, {
      system: 'backlog',
      query: 'To Do,In Progress',
      statuses: { in_progress: 'In Progress', in_review: 'In Review' },
      path: './board',
      urlBase: 'https://github.com/acme/widgets/blob/main',
      role: 'engineer',
    })
    // No block is the old behaviour: a fleet that never asked for a board has none.
    assert.equal(decodeProfile(minimal()).trackers, undefined)
  })

  it('refuses a tracker it cannot build, and a block with no query', () => {
    assert.throws(() => decodeProfile(minimal({ trackers: { system: 'jira', query: 'open', path: '.' } })), /jira/)
    assert.throws(() => decodeProfile(minimal({ trackers: { system: 'backlog', path: '.' } })), /query/)
    assert.throws(() => decodeProfile(minimal({ trackers: { system: 'backlog', query: 'open' } })), /path/)
  })

  it('refuses a misspelt state in the status map, which would be a transition nobody sees', () => {
    const trackers = { system: 'backlog', query: 'To Do', statuses: { in_progres: 'Doing' }, path: '.' }
    assert.throws(() => decodeProfile(minimal({ trackers })), /in_progres/)
  })

  it('refuses an empty status name, and keeps a state the profile leaves out unmapped', () => {
    const empty = { system: 'backlog', query: 'To Do', statuses: { merged: '  ' }, path: '.' }
    assert.throws(() => decodeProfile(minimal({ trackers: empty })), /merged/)

    const partial = { system: 'backlog', query: 'To Do', statuses: { in_progress: 'Doing' }, path: '.' }
    assert.deepEqual(decodeProfile(minimal({ trackers: partial })).trackers?.statuses, { in_progress: 'Doing' })
  })

  it('reads the DeepInfra block: the ids this fleet may run, and the endpoint it runs them on', () => {    const profile = decodeProfile(
      minimal({
        providers: {
          deepinfra: { allowedModels: ['deepseek-ai/DeepSeek-V4.1-Flash-1017'], baseUrl: 'https://deepinfra.staging/anthropic' },
        },
      }),
    )
    assert.deepEqual(profile.providers?.deepinfra?.allowedModels, ['deepseek-ai/DeepSeek-V4.1-Flash-1017'])
    assert.equal(profile.providers?.deepinfra?.baseUrl, 'https://deepinfra.staging/anthropic')
    // No block is the old behaviour, and it must stay readable: most profiles have none.
    assert.equal(decodeProfile(minimal()).providers, undefined)
  })

  it('refuses a misspelt key inside the provider block, and an empty allowlist that permits nothing', () => {
    // A profile is hand-written; `allowedModel` would decode to "no policy" if it
    // were dropped, which is the one outcome an allowlist must not have.
    assert.throws(() => decodeProfile(minimal({ providers: { deepinfra: { allowedModel: ['m'] } } })), /unknown field/)
    assert.throws(() => decodeProfile(minimal({ providers: { deepinfra: { allowedModels: [] } } })), /at least one model/)
    assert.throws(() => decodeProfile(minimal({ providers: { opencode: {} } })), /unknown field/)
  })

  it('reads where the key is, never the key: a variable name and a file path', () => {
    const profile = decodeProfile(
      minimal({ providers: { deepinfra: { tokenEnv: 'MY_DEEPINFRA_KEY', tokenFile: '/run/secrets/deepinfra' } } }),
    )
    assert.equal(profile.providers?.deepinfra?.tokenEnv, 'MY_DEEPINFRA_KEY')
    assert.equal(profile.providers?.deepinfra?.tokenFile, '/run/secrets/deepinfra')
    // Both are optional: the defaults are what most machines use.
    const bare = decodeProfile(minimal({ providers: { deepinfra: {} } }))
    assert.equal(bare.providers?.deepinfra?.tokenEnv, undefined)
    assert.equal(bare.providers?.deepinfra?.tokenFile, undefined)
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
