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
import { planRoutines } from '@fleet/orchestration-routines'
import { defaultPurgeLimits } from '@fleet/runtime-supervisor'

import {
  decodeProfile,
  effortFor,
  effortWarnings,
  loadProfile,
  modelFor,
  purgeLimitsOf,
  type Profile,
} from '../src/config/profile.ts'

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

  it('reads §6.1’s budget, and reads no block as no cap', () => {
    assert.equal(decodeProfile(minimal()).budget, undefined)
    assert.deepEqual(decodeProfile(minimal({ budget: { usd: 40 } })).budget, { usd: 40 })
    // A cap of zero would ask the moment the first turn is billed: a number, but not a budget.
    assert.throws(() => decodeProfile(minimal({ budget: { usd: 0 } })), /above zero/)
    assert.throws(() => decodeProfile(minimal({ budget: { usd: -5 } })), /budget/)
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
    assert.throws(() => decodeProfile(minimal({ trackers: { system: 'trello', query: 'open', path: '.' } })), /system/)
    assert.throws(() => decodeProfile(minimal({ trackers: { system: 'backlog', path: '.' } })), /query/)
    assert.throws(() => decodeProfile(minimal({ trackers: { system: 'backlog', query: 'open' } })), /path/)
  })

  it('reads a Jira block that says where its credential lives, in either shape', () => {
    const cloud = decodeProfile(
      minimal({
        trackers: {
          system: 'jira',
          query: 'project = FLEET AND status != Done',
          baseUrl: 'https://acme.atlassian.net',
          auth: { kind: 'cloud', email: 'fleet@acme.test', tokenEnv: 'ACME_JIRA_API_TOKEN' },
          statuses: { in_progress: 'In Progress' },
          role: 'engineer',
        },
      }),
    )
    assert.deepEqual(cloud.trackers, {
      system: 'jira',
      query: 'project = FLEET AND status != Done',
      baseUrl: 'https://acme.atlassian.net',
      auth: { kind: 'cloud', email: 'fleet@acme.test', tokenEnv: 'ACME_JIRA_API_TOKEN' },
      statuses: { in_progress: 'In Progress' },
      role: 'engineer',
    })

    // A Server / Data Center install: a PAT is already an identity, so no email half.
    const pat = decodeProfile(
      minimal({
        trackers: {
          system: 'jira',
          query: 'project = FLEET',
          baseUrl: 'https://jira.acme.test',
          auth: { kind: 'pat', tokenFile: '/run/secrets/jira' },
        },
      }),
    )
    assert.deepEqual(pat.trackers, {
      system: 'jira',
      query: 'project = FLEET',
      baseUrl: 'https://jira.acme.test',
      auth: { kind: 'pat', tokenFile: '/run/secrets/jira' },
    })

    // Both sources are optional, as they are for DeepInfra: a profile that names
    // neither gets the defaults, and the token is read at compose — not here.
    const bare = decodeProfile(
      minimal({
        trackers: {
          system: 'jira',
          query: 'project = FLEET',
          baseUrl: 'https://jira.acme.test',
          auth: { kind: 'pat' },
        },
      }),
    )
    assert.deepEqual(bare.trackers, {
      system: 'jira',
      query: 'project = FLEET',
      baseUrl: 'https://jira.acme.test',
      auth: { kind: 'pat' },
    })
  })

  it('refuses a Jira block that writes the token down, and one carrying a Backlog key', () => {
    // The rule the DeepInfra block states holds here too: a profile is a file in
    // the repo's reach, and a token in it would be a token in `git status`. The
    // refusal is an unknown field, so a pasted token is not quietly accepted.
    const withToken = {
      system: 'jira',
      query: 'open',
      baseUrl: 'https://acme.test',
      auth: { kind: 'cloud', email: 'fleet@acme.test', token: 's3cr3t' },
    }
    assert.throws(() => decodeProfile(minimal({ trackers: withToken })), /token/)

    // `system` decides which keys are read: a Jira site has no directory to run in.
    const withPath = { system: 'jira', query: 'open', baseUrl: 'https://acme.test', path: '.', auth: { kind: 'pat' } }
    assert.throws(() => decodeProfile(minimal({ trackers: withPath })), /path/)
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

  it('reads `comments` as off unless the profile says otherwise, on either board', () => {
    // A note is peer-written prose, and the board a profile maps is not
    // necessarily the fleet's own. Naming no `comments` must therefore decode to
    // *nothing*, not to `false` — the routine treats absence as the closed gate,
    // and a spelled-out `false` would be a second way to say the same thing.
    const jira = decodeProfile(
      minimal({
        trackers: {
          system: 'jira',
          query: 'project = FLEET',
          baseUrl: 'https://jira.acme.test',
          auth: { kind: 'pat' },
        },
      }),
    )
    assert.equal(jira.trackers?.comments, undefined)

    const backlog = decodeProfile(
      minimal({ trackers: { system: 'backlog', query: 'To Do', path: '.', comments: true } }),
    )
    assert.equal(backlog.trackers?.comments, true)

    // Strict decode, so the setting cannot arrive misspelt and be silently off.
    const misspelt = { system: 'backlog', query: 'To Do', path: '.', comment: true }
    assert.throws(() => decodeProfile(minimal({ trackers: misspelt })), /comment/)
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
    assert.throws(() => decodeProfile(minimal({ providers: { codex: {} } })), /unknown field/)
  })

  it('reads a cursor peer’s context windows, and refuses a window that could not hold a turn', () => {
    // The only thing a cursor block may say: the CLI reports no window, so this is
    // the sole source for the limit a purge is measured against.
    const profile = decodeProfile(
      minimal({ providers: { cursor: { contextLimits: { 'composer-2.5': 200_000, 'gpt-5.2': 272_000 } } } }),
    )
    assert.deepEqual(profile.providers?.cursor?.contextLimits, { 'composer-2.5': 200_000, 'gpt-5.2': 272_000 })
    assert.throws(
      () => decodeProfile(minimal({ providers: { cursor: { contextLimits: { 'composer-2.5': 0 } } } })),
      /positive|at least|0/,
    )
    // Being read-only is not a setting: a profile cannot ask for a writing peer.
    assert.throws(() => decodeProfile(minimal({ providers: { cursor: { permissionMode: 'default' } } })), /unknown field/)
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
    // Since TASK-12 the model may also come from the peer's role, so the refusal
    // names both places it could have been written: a message that said only
    // "peer engineer-1 has no model" would leave the reader guessing whether the
    // fix was the peer, or a `roles` block they may never have heard of.
    assert.throws(
      () => decodeProfile(minimal({ peers: [{ id: 'engineer-1', role: 'engineer', provider: 'claude' }] })),
      (thrown: unknown) => {
        const message = (thrown as Error).message
        assert.match(message, /peer 'engineer-1' declares no model/)
        assert.match(message, /add `model` to that peer, or a `roles: \{ engineer: \{ model: … \} \}` block/)
        return true
      },
    )
  })

  it('refuses a peer id that is not a peer id, and a provider the daemon cannot build', () => {
    assert.throws(
      () => decodeProfile(minimal({ peers: [{ id: 'Engineer 1', role: 'e', provider: 'claude', model: 'm' }] })),
      /PeerId|peer/i,
    )
    assert.throws(
      () => decodeProfile(minimal({ peers: [{ id: 'engineer-1', role: 'e', provider: 'codex', model: 'm' }] })),
      /claude|deepinfra|cursor/,
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

describe('the routines block', () => {
  it('configures the routine the profile names, spelled the way the file spells it', () => {
    const profile = decodeProfile(
      minimal({ routines: { dispatch: { enabled: false }, standup: { at: '07:30' } } }),
    )
    assert.deepEqual(profile.routines, { dispatch: { enabled: false }, standup: { at: '07:30' } })
    // The claim that used to be false: a routine the profile disabled is gone
    // from the plan the scheduler builds, not still running with its defaults.
    const planned = planRoutines(profile.routines).map((routine) => routine.kind)
    assert.equal(planned.includes('dispatch'), false)
    assert.ok(planned.includes('reconcile'), 'a routine the profile does not name still runs')
  })

  it('refuses a routine the fleet does not have, naming it', () => {
    assert.throws(
      () => decodeProfile(minimal({ routines: { dispatchh: { enabled: true } } })),
      /routines\.dispatchh: is not a routine; this fleet has dispatch, /,
    )
  })

  it('refuses a misspelt setting rather than dropping it', () => {
    assert.throws(() => decodeProfile(minimal({ routines: { dispatch: { enabeld: true } } })), /routines\.dispatch\.enabeld/)
  })

  it('refuses the old nested spelling instead of ignoring it', () => {
    // One version read `routines: {routines: {...}}`, which no live profile ever
    // wrote. Now that the file's shape is the config's, that spelling is a typo
    // like any other, and it says so rather than silently configuring nothing.
    assert.throws(
      () => decodeProfile(minimal({ routines: { routines: { dispatch: { enabled: false } } } })),
      /routines\.routines: is not a routine/,
    )
  })

  it('reports a bad profile as the file and the issue, not as a stack trace', async () => {
    const file = await tempProfile(
      'engineer',
      `profile: engineer
repos: []
peers: [{ id: engineer-1, role: a, provider: claude, model: m }]
routines:
  dispatchh: { enabled: true }
`,
    )
    await assert.rejects(
      loadProfile(file, 'engineer'),
      (thrown: unknown) =>
        (thrown as { code?: string }).code === 'invalid_input' && /routines\.dispatchh/.test((thrown as Error).message),
    )
  })
})

describe('the purge limits a profile asks for', () => {
  it('is the supervisor’s defaults when the profile says nothing', () => {
    // One set of defaults, in `runtime/supervisor`: a second copy here is how
    // the daemon and the supervisor drifted apart in the first place.
    assert.deepEqual(purgeLimitsOf(decodeProfile(minimal())), defaultPurgeLimits)
    assert.deepEqual(purgeLimitsOf(decodeProfile(minimal({ limits: {} }))), defaultPurgeLimits)
    // The cost lever, as opposed to a safety margin: a peer hands off at 60% of
    // its window rather than paying to re-read the expensive last 20%.
    assert.equal(defaultPurgeLimits.contextRatio, 0.6)
  })

  it('tunes the thresholds it names and keeps the rest', () => {
    const profile = decodeProfile(minimal({ limits: { purge: { maxTurns: 12 } } }))
    assert.deepEqual(purgeLimitsOf(profile), { ...defaultPurgeLimits, maxTurns: 12 })

    const all = decodeProfile(
      minimal({ limits: { purge: { contextRatio: 0.5, maxTurns: 12, maxSessionMinutes: 90 } } }),
    )
    assert.deepEqual(purgeLimitsOf(all), {
      contextRatio: 0.5,
      autoCompactRatio: defaultPurgeLimits.autoCompactRatio,
      maxTurns: 12,
      // Minutes in the profile, milliseconds in the supervisor: a profile is
      // read by people, and the conversion happens once, here.
      maxSessionMillis: 90 * 60_000,
    })
  })

  it('refuses a ratio outside (0, 1] at decode, not at the first turn', () => {
    // The schema cannot say this: the range belongs to `checkPurgeLimits`, so a
    // 1.5 would be a ratio that never triggers, i.e. a fleet that never purges.
    assert.throws(() => decodeProfile(minimal({ limits: { purge: { contextRatio: 1.5 } } })), /contextRatio/)
    assert.throws(() => decodeProfile(minimal({ limits: { purge: { contextRatio: 0 } } })), /contextRatio/)
  })

  it('refuses a misspelt threshold rather than leaving the fleet on the default', () => {
    assert.throws(() => decodeProfile(minimal({ limits: { purge: { maxTurn: 12 } } })), /unknown field/)
    // And the block itself is strict: `purges` would otherwise read as "no block".
    assert.throws(() => decodeProfile(minimal({ limits: { purges: {} } })), /unknown field/)
  })

  it('refuses a turn count or a duration that is not a positive integer', () => {
    assert.throws(() => decodeProfile(minimal({ limits: { purge: { maxTurns: 0 } } })), /maxTurns/)
    assert.throws(() => decodeProfile(minimal({ limits: { purge: { maxSessionMinutes: -5 } } })), /maxSessionMinutes/)
  })
})

/**
 * §5.3: who answers the Judge.
 *
 * The block exists because its absence had a silent meaning: the Judge's call
 * was built with no env, so it ran as whatever identity fleetd was started with.
 * These tests keep the block honest — a provider it does not know, or a block
 * with no model, is refused by name rather than falling back to the default the
 * block was written to override.
 */
describe('the judge block', () => {
  it('reads the provider and the model that answer §5.3’s questions', () => {
    const profile = decodeProfile(minimal({ judge: { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' } }))
    assert.deepEqual(profile.judge, { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' })
  })

  it('is absent by default, which keeps the old behaviour', () => {
    assert.equal(decodeProfile(minimal()).judge, undefined)
  })

  it('refuses a provider this build has no adapter for', () => {
    assert.throws(() => decodeProfile(minimal({ judge: { provider: 'openai', model: 'gpt-5' } })), /openai/)
  })

  it('refuses `cursor` as the judge, rather than accepting it and answering with another provider (TASK-79)', () => {
    // The Judge's transport is one schema-constrained completion through the Claude SDK
    // (claude, or deepinfra's Anthropic-compatible endpoint). cursor-agent is a read-only
    // agent CLI with no such call, so a `cursor` judge would send a cursor model id to the
    // Claude SDK on fleetd's own login: ignored, silently. It is refused at load instead.
    assert.throws(
      () => decodeProfile(minimal({ judge: { provider: 'cursor', model: 'composer-2.5' } })),
      /judge.*cursor|cursor.*judge|claude or deepinfra/,
    )
  })

  it('still accepts claude and deepinfra as the judge', () => {
    for (const provider of ['claude', 'deepinfra']) {
      assert.equal(decodeProfile(minimal({ judge: { provider, model: 'some-model' } })).judge?.provider, provider)
    }
  })

  it('refuses a block with no model, rather than defaulting to one the provider may not serve', () => {
    assert.throws(() => decodeProfile(minimal({ judge: { provider: 'deepinfra' } })), /model/)
  })

  it('refuses a field it does not know', () => {
    assert.throws(
      () => decodeProfile(minimal({ judge: { provider: 'claude', model: 'claude-haiku-4-5', temperature: 0.2 } })),
      /unknown field|temperature/,
    )
  })
})

/**
 * TASK-12: the model and the reasoning level every peer of a role starts on.
 *
 * The precedence is the whole feature — a peer's own word wins, its role's fills
 * the gap — and the point of putting the default in the *profile* rather than in
 * the daemon is that nothing here invents a value: what the file does not say is
 * either refused (a model) or left to the provider (an effort).
 */
describe('a role’s model and effort (TASK-12)', () => {
  const roleEngineer = { engineer: { model: 'claude-haiku-4-5', effort: 'low' } } as const

  it('takes the model and the effort from the peer first, then from its role', () => {
    const profile = decodeProfile(
      minimal({
        roles: roleEngineer,
        peers: [
          // Names neither: the role answers both.
          { id: 'engineer-1', role: 'engineer', provider: 'claude' },
          // Names both: the peer wins, which is what lets one peer differ.
          {
            id: 'engineer-2',
            role: 'engineer',
            provider: 'claude',
            model: 'claude-opus-5-5',
            effort: 'high',
          },
          // Names only the model: the role still supplies the effort, because
          // the two are resolved independently and one does not imply the other.
          { id: 'engineer-3', role: 'engineer', provider: 'claude', model: 'claude-sonnet-5-5' },
        ],
      }),
    )
    const [fromRole, fromPeer, mixed] = profile.peers
    assert.equal(modelFor(profile, fromRole!), 'claude-haiku-4-5')
    assert.equal(effortFor(profile, fromRole!), 'low')
    assert.equal(modelFor(profile, fromPeer!), 'claude-opus-5-5')
    assert.equal(effortFor(profile, fromPeer!), 'high')
    assert.equal(modelFor(profile, mixed!), 'claude-sonnet-5-5')
    assert.equal(effortFor(profile, mixed!), 'low')
  })

  it('leaves the effort unset when neither the peer nor the role names one, rather than picking a level', () => {
    // Absent is a real answer: the provider's own default. A daemon-invented
    // 'medium' would be a policy about how much a peer may think.
    const profile = decodeProfile(minimal({ roles: { engineer: { model: 'claude-haiku-4-5' } } }))
    assert.equal(effortFor(profile, profile.peers[0]!), undefined)
  })

  it('uses the role’s model for a peer that names none, so a `roles` block alone is enough', () => {
    // `decodeProfile` resolves every peer's model up front: a `roles` block that
    // forgot a role is a profile mistake, and `fleet up` is where it belongs.
    const profile = decodeProfile(
      minimal({ roles: roleEngineer, peers: [{ id: 'engineer-1', role: 'engineer', provider: 'claude' }] }),
    )
    assert.equal(modelFor(profile, profile.peers[0]!), 'claude-haiku-4-5')
    // A role nobody fills is not an error: a profile may plan a role it has not hired yet.
    assert.deepEqual(decodeProfile(minimal({ roles: { reviewer: { model: 'gpt-5.2' } } })).roles, {
      reviewer: { model: 'gpt-5.2' },
    })
  })

  it('refuses an effort that is not one of the levels, instead of passing it to a provider', () => {
    assert.throws(() => decodeProfile(minimal({ roles: { engineer: { effort: 'turbo' } } })), /turbo|one of/)
    assert.throws(
      () =>
        decodeProfile(
          minimal({ peers: [{ id: 'engineer-1', role: 'engineer', provider: 'claude', model: 'm', effort: 'turbo' }] }),
        ),
      /turbo|one of/,
    )
    // The block is strict like every other: `efforts` would read as "no opinion".
    assert.throws(() => decodeProfile(minimal({ roles: { engineer: { efforts: { max: 1 } } } })), /unknown field/)
  })

  it('warns, naming the peer, when the provider cannot honour the effort — and only then', () => {
    const profile = decodeProfile(
      minimal({
        roles: roleEngineer,
        peers: [
          // cursor cannot: the CLI has no reasoning level to set.
          { id: 'reviewer-1', role: 'engineer', provider: 'cursor', model: 'gpt-5.2' },
          // claude can, so saying nothing is the truth for the engineer.
          { id: 'engineer-1', role: 'engineer', provider: 'claude' },
        ],
      }),
    )
    const capabilities = (provider: string) => (provider === 'cursor' ? { effort: false } : { effort: true })
    assert.deepEqual(effortWarnings(profile, capabilities), [
      "peer 'reviewer-1' asks for effort 'low', but provider 'cursor' cannot honour it: the session starts at that provider's own default",
    ])
    // A provider this daemon wired none of (a test, or a peer whose provider
    // block asked for nothing) has no capability to contradict the profile.
    assert.deepEqual(effortWarnings(profile, () => undefined), [])
    // And a profile that asks for no effort is never warned about, whichever
    // provider it is on: the warning is about the request, not the provider.
    const noEffort = decodeProfile(minimal({ peers: [{ id: 'r-1', role: 'e', provider: 'cursor', model: 'm' }] }))
    assert.deepEqual(effortWarnings(noEffort, capabilities), [])
  })
})

describe('the coord block (shared-fleet.md §6)', () => {
  const coord = (overrides: Record<string, unknown> = {}) => ({
    repo: 'backbase-se/fleet-project',
    team: 'backbase-se/project',
    ...overrides,
  })

  it('reads a project, and no block as a fleet on its own', () => {
    assert.equal(decodeProfile(minimal()).coord, undefined)
    assert.deepEqual(decodeProfile(minimal({ budget: { usd: 300 }, coord: coord({ user: 'mohammads_backbase' }) })).coord, {
      repo: 'backbase-se/fleet-project',
      team: 'backbase-se/project',
      user: 'mohammads_backbase',
    })
  })

  it('refuses task data, which needs Legal sign-off and nothing in this build honours', () => {
    assert.deepEqual(decodeProfile(minimal({ coord: coord({ taskData: false }) })).coord?.taskData, false)
    assert.throws(() => decodeProfile(minimal({ coord: coord({ taskData: true }) })), /taskData/)
  })

  it('refuses a repo or a team that is not <org>/<name>', () => {
    assert.throws(() => decodeProfile(minimal({ coord: coord({ repo: 'fleet-project' }) })), /repo/)
    assert.throws(() => decodeProfile(minimal({ coord: coord({ team: 'backbase-se/' }) })), /team/)
    assert.throws(() => decodeProfile(minimal({ coord: { repo: 'backbase-se/fleet-project' } })), /team/)
  })

  it('refuses the namespace a shared repository once needed, now that a repository is one project', () => {
    assert.throws(() => decodeProfile(minimal({ coord: coord({ engagement: 'eng-07' }) })), /engagement/)
  })

  it('refuses a project with no budget, because a fleet with no cap has no pace', async () => {
    const file = await tempProfile(
      'engineer',
      `profile: engineer
repos: [backbase/me-services-fleet]
peers:
  - { id: engineer-1, role: engineer, provider: claude, model: claude-sonnet-5-5 }
coord: { repo: backbase-se/fleet-project, team: backbase-se/project }
`,
    )
    await assert.rejects(loadProfile(file, 'engineer'), /no `budget`/)
  })
})
