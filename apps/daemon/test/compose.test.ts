/**
 * The composition root (§2): what a profile's `providers` block actually does.
 *
 * Two things are worth a test here. The first is that the block reaches the
 * adapter at all — a profile is only a policy if something hands it over, and
 * `buildProviders` is the one place that happens. The second is that the policy
 * is reached from `fleet up`, not only from a direct call: an allowlist that a
 * peer can walk past at start would be decoration.
 *
 * Everything else about the adapter is tested in its own package; this file
 * tests the wiring.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { profilePaths, type PeerId, type TurnId } from '@fleet/foundation-core'
import type { Tracker } from '@fleet/foundation-contracts'

import { buildProviders, compose, bookkeepingFailureLine } from '../src/wiring/compose.ts'
import { decodeProfile, type Profile } from '../src/config/profile.ts'

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
const OTHER = 'deepseek-ai/DeepSeek-V3.2'

const profileWith = (allowedModels?: readonly string[], peerModel = MODEL): Profile =>
  decodeProfile({
    profile: 'deepinfra-ids',
    repos: ['backbase/me-services-fleet'],
    peers: [{ id: 'engineer-1', role: 'engineer', provider: 'deepinfra', model: peerModel }],
    ...(allowedModels === undefined ? {} : { providers: { deepinfra: { allowedModels } } }),
  })

const code = (thrown: unknown): string | undefined => (thrown as { code?: string }).code

describe('the profile’s DeepInfra block, as the daemon builds it', () => {
  it('hands the allowlist to the adapter, which refuses an id off it and takes one on it', async () => {
    const provider = buildProviders(profileWith([MODEL])).get('deepinfra')
    assert.ok(provider !== undefined, 'a profile naming a deepinfra peer builds one')
    // An unknown handle, so the only thing that can differ between the two calls
    // is the model: `not_found` means the id was accepted and `config_mismatch`
    // means the adapter refused it before it looked at the handle at all.
    await assert.rejects(
      provider.setModel({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never, OTHER),
      (thrown: unknown) => code(thrown) === 'config_mismatch',
    )
    await assert.rejects(
      provider.setModel({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never, MODEL),
      (thrown: unknown) => code(thrown) === 'not_found',
    )
  })

  it('allows any model with a configured window when the profile names no allowlist', async () => {
    // The old behaviour, and the one most profiles get: no block, no policy.
    const provider = buildProviders(profileWith(undefined)).get('deepinfra')
    assert.ok(provider !== undefined)
    await assert.rejects(
      provider.setModel({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never, OTHER),
      // Not "off the allowlist" because there is none — merely unconfigured here.
      (thrown: unknown) => code(thrown) === 'invalid_input',
    )
  })

  it('fleet up fails with the typed config_mismatch when a peer’s model is off the list', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fleet-compose-'))
    const configHome = join(home, '.config')
    const paths = profilePaths('deepinfra-ids', { home, configHome })
    await mkdir(join(configHome, 'fleet', 'profiles'), { recursive: true })
    await writeFile(
      paths.profileFile,
      `profile: deepinfra-ids
repos: [backbase/me-services-fleet]
peers:
  - id: engineer-1
    role: engineer
    provider: deepinfra
    model: ${OTHER}
providers:
  deepinfra:
    allowedModels:
      - ${MODEL}
`,
      'utf8',
    )

    // A key, so the refusal under test is the allowlist and not the missing
    // credential: the env is built before the provider is asked to start.
    const composed = await compose({
      profileName: 'deepinfra-ids',
      roots: { home, configHome },
      environ: { DEEPINFRA_API_KEY: 'not-a-real-key' },
    })
    try {
      // `up()` starts the supervisor first, so the refusal happens before the
      // scheduler is running and nothing is left ticking behind the assertion.
      await assert.rejects(composed.daemon.up(), (thrown: unknown) => code(thrown) === 'config_mismatch')
    } finally {
      await composed.daemon.down().catch(() => {})
      await composed.server.close().catch(() => {})
      await composed.store.close().catch(() => {})
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('the profile’s tracker block, as the daemon builds it', () => {
  /**
   * A fleet with one peer and, when `trackers` is given, the YAML block for a
   * board. `ownTracker: false` leaves `deps.tracker` unset, so the adapter the
   * profile names is the one that gets built.
   */
  const withTrackers = async (
    trackers?: string,
    options: { readonly ownTracker?: boolean; readonly environ?: Readonly<Record<string, string>> } = {},
  ): Promise<{ home: string; composed: Awaited<ReturnType<typeof compose>> }> => {
    const home = await mkdtemp(join(tmpdir(), 'fleet-trackers-'))
    const configHome = join(home, '.config')
    const paths = profilePaths('board', { home, configHome })
    await mkdir(join(configHome, 'fleet', 'profiles'), { recursive: true })
    await writeFile(
      paths.profileFile,
      `profile: board
repos: [backbase/me-services-fleet]
peers:
  - id: engineer-1
    role: engineer
    provider: claude
    model: claude-sonnet-5-5
${trackers ?? ''}`,
      'utf8',
    )
    const composed = await compose({
      profileName: 'board',
      roots: { home, configHome },
      ...(options.environ === undefined ? {} : { environ: options.environ }),
      ...(trackers === undefined || options.ownTracker === false ? {} : { tracker: neverAsked() }),
    })
    return { home, composed }
  }

  /** A tracker that would fail the test if the body ever reached the CLI: nothing in this file polls a board. */
  const neverAsked = (): Tracker => ({
    pull: async () => assert.fail('a composed fleet must not pull a board before it is started'),
    get: async () => assert.fail('a composed fleet must not read a card before it is started'),
    transition: async () => assert.fail('a composed fleet must not move a card before it is started'),
    link: async () => assert.fail('a composed fleet must not link a PR before it is started'),
    comment: async () => assert.fail('a composed fleet must not comment on a card before it is started'),
  })

  const clean = async (home: string, composed: Awaited<ReturnType<typeof compose>>): Promise<void> => {
    await composed.daemon.down().catch(() => {})
    await composed.server.close().catch(() => {})
    await composed.store.close().catch(() => {})
    await rm(home, { recursive: true, force: true })
  }

  it('installs tracker-sync when the profile names a board', async () => {
    const { home, composed } = await withTrackers(`trackers:
  system: backlog
  query: To Do,In Progress
  path: ./board
  statuses:
    in_progress: In Progress
`)
    try {
      assert.ok(composed.scheduler.plan.installed.includes('tracker-sync'))
      assert.equal(composed.scheduler.plan.unimplemented.includes('tracker-sync'), false)
    } finally {
      await clean(home, composed)
    }
  })

  it('wires the Jira adapter when the profile names a site, with no board directory in sight', async () => {
    // No `deps.tracker`, so the adapter the profile names is the one built: had
    // this still gone to Backlog.md, there is no `path` for it to run in. The
    // token comes from fleetd's environment, because the profile never holds one.
    const { home, composed } = await withTrackers(
      `trackers:
  system: jira
  query: project = FLEET AND status != Done
  baseUrl: https://acme.atlassian.net
  auth:
    kind: cloud
    email: fleet@acme.test
  statuses:
    in_progress: In Progress
`,
      { ownTracker: false, environ: { JIRA_API_TOKEN: 'not-a-real-jira-token' } },
    )
    try {
      assert.ok(composed.scheduler.plan.installed.includes('tracker-sync'))
      assert.equal(composed.scheduler.plan.unimplemented.includes('tracker-sync'), false)
    } finally {
      await clean(home, composed)
    }
  })

  it('refuses a Jira site whose token is in neither place, at compose, before any routine can run', async () => {
    // Neither `JIRA_API_TOKEN` in the environment nor a token file under
    // `configHome`: a configuration fault, not a site that refuses to answer.
    await assert.rejects(
      () =>
        withTrackers(
          `trackers:
  system: jira
  query: project = FLEET
  baseUrl: https://acme.atlassian.net
  auth:
    kind: cloud
    email: fleet@acme.test
`,
          { ownTracker: false, environ: {} },
        ),
      /no Jira token/,
    )
  })

  it('refuses a Jira site that is not https, at compose, before any routine can run', async () => {
    await assert.rejects(
      () =>
        withTrackers(
          `trackers:
  system: jira
  query: project = FLEET
  baseUrl: http://acme.atlassian.net
  auth:
    kind: pat
`,
          { ownTracker: false, environ: { JIRA_PAT: 'not-a-real-pat' } },
        ),
      /must be https/,
    )
  })

  it('installs no tracker-sync when it names none, rather than one that polls nothing', async () => {
    const { home, composed } = await withTrackers()
    try {
      assert.equal(composed.scheduler.plan.installed.includes('tracker-sync'), false)
      assert.ok(composed.scheduler.plan.unimplemented.includes('tracker-sync'))
    } finally {
      await clean(home, composed)
    }
  })
})

/**
 * §5.3's Judge, as `fleet up` builds it.
 *
 * The daemon used to build the Judge's transport with no env, so its one-shot
 * call ran on fleetd's ambient identity: on a machine with no Claude login it
 * answered `subtype: success` with no structured output and every `thin_card`
 * escalated forever; on a machine with one it silently judged as that login.
 *
 * A profile that names a `judge:` block must therefore be able to make the
 * composition root read that provider's credential — and must be refused at
 * start when it cannot, rather than falling back to the machine.
 */
describe('the profile’s judge block, as the daemon builds it', () => {
  const withJudge = async (judge: string): Promise<string> => {
    const home = await mkdtemp(join(tmpdir(), 'fleet-judge-'))
    const configHome = join(home, '.config')
    const paths = profilePaths('judged', { home, configHome })
    await mkdir(join(configHome, 'fleet', 'profiles'), { recursive: true })
    await writeFile(
      paths.profileFile,
      `profile: judged
repos: [backbase/me-services-fleet]
peers:
  - id: engineer-1
    role: engineer
    provider: claude
    model: claude-sonnet-5-5
${judge}
`,
      'utf8',
    )
    return home
  }

  it('refuses to start when the judge names a provider whose key is missing', async () => {
    // The point of the test: this refusal can only happen if the block reached
    // the env builder. A compose that ignored `judge:` would start happily and
    // judge on whatever identity the machine has.
    const home = await withJudge(`judge:
  provider: deepinfra
  model: ${MODEL}
`)
    try {
      await assert.rejects(
        compose({ profileName: 'judged', roots: { home, configHome: join(home, '.config') }, environ: {} }),
        (thrown: unknown) => code(thrown) === 'config_mismatch',
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('asks the model the block names, so the request and the pinned env agree', async () => {
    const home = await withJudge(`judge:
  provider: deepinfra
  model: ${MODEL}
`)
    const composed = await compose({
      profileName: 'judged',
      roots: { home, configHome: join(home, '.config') },
      environ: { DEEPINFRA_API_KEY: 'not-a-real-key' },
    })
    try {
      // Without this the transport would pin DeepSeek in the env and then ask
      // for `claude-haiku-4-5` in the request, which is the same vendor mismatch
      // in a different place.
      assert.equal(composed.judge.model, MODEL)
    } finally {
      await composed.daemon.down().catch(() => {})
      await composed.server.close().catch(() => {})
      await composed.store.close().catch(() => {})
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('a bookkeeping append the store refused (TASK-57)', () => {
  // TASK-4 stopped a refused row from failing a healthy session, at the cost of
  // dropping it in silence. The daemon's half of the fix is this line: it has to
  // name the peer and the turn, or the person reading the log cannot tell which
  // measurement went missing, and the reason, or they cannot tell why.
  it('is one log line naming the peer, the turn and what the store said', () => {
    const line = bookkeepingFailureLine({
      peerId: 'engineer-1' as PeerId,
      record: 'peer.tool_used',
      turnId: 'trn_0123456789abcdef' as TurnId,
      error: new Error('database is locked'),
    })
    assert.equal(
      line,
      'fleetd: bookkeeping for engineer-1 failed writing peer.tool_used on turn trn_0123456789abcdef and the session stays live: database is locked',
    )
  })

  // TASK-82: a state change or a compaction has no turn of its own, and the line must not invent one — what it has
  // to name is the row that went missing.
  it('names the row without a turn when the row belonged to none', () => {
    const line = bookkeepingFailureLine({
      peerId: 'engineer-1' as PeerId,
      record: 'peer.compacted',
      error: new Error('database is locked'),
    })
    assert.equal(
      line,
      'fleetd: bookkeeping for engineer-1 failed writing peer.compacted and the session stays live: database is locked',
    )
  })

  it('still says something usable when the store threw something that is not an Error', () => {
    const line = bookkeepingFailureLine({
      peerId: 'engineer-1' as PeerId,
      record: 'turn.usage_recorded',
      turnId: 'trn_0123456789abcdef' as TurnId,
      error: 'SQLITE_BUSY',
    })
    assert.match(line, /failed writing turn\.usage_recorded on turn trn_0123456789abcdef .*: SQLITE_BUSY$/)
  })
})
