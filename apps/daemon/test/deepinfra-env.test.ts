/**
 * §4: the one place a DeepInfra key is read, and what it is never allowed to
 * reach — a message, an error detail, an event, a process argument.
 *
 * The adapter's own tests cover the endpoint and the model pin; what is tested
 * here is the *daemon's* half: which of the two sources wins, when the read
 * happens, and what a refusal is allowed to say. The token in these tests is a
 * string that could not be a real key, so an accidental echo is obvious.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { newBriefId } from '@fleet/foundation-core'
import { createDeepInfraProvider, type DeepInfraProviderConfig } from '@fleet/runtime-provider-deepinfra'

import {
  createProviderEnv,
  DEFAULT_DEEPINFRA_TOKEN_ENV,
  defaultDeepInfraTokenFile,
  readDeepInfraToken,
  type DeepInfraEnvOptions,
} from '../src/deepinfra-env.ts'
import { decodeProfile, type PeerProfile, type Profile } from '../src/profile.ts'

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
const TOKEN = 'not-a-real-deepinfra-key-0000'
const CONFIG_HOME = '/home/tester/.config'

const profileWith = (overrides: Record<string, unknown> = {}): Profile =>
  decodeProfile({
    profile: 'engineer',
    repos: ['backbase/me-services-fleet'],
    peers: [{ id: 'engineer-1', role: 'engineer', provider: 'deepinfra', model: MODEL }],
    ...overrides,
  })

const optionsWith = (
  overrides: Partial<Omit<DeepInfraEnvOptions, 'profile'>> & { readonly profile?: Profile } = {},
): DeepInfraEnvOptions => ({
  profile: overrides.profile ?? profileWith(),
  environ: overrides.environ ?? {},
  configHome: overrides.configHome ?? CONFIG_HOME,
  ...(overrides.readText === undefined ? {} : { readText: overrides.readText }),
})

const code = (thrown: unknown): string | undefined => (thrown as { code?: string }).code
/** Everything an error would print if it were logged: message and details both. */
const rendered = (thrown: unknown): string =>
  JSON.stringify({ message: (thrown as Error).message, ...(thrown as { details?: unknown }) })

/** The one peer of a test profile. */
const peerOf = (profile: Profile): PeerProfile => {
  const [peer] = profile.peers
  assert.ok(peer !== undefined)
  return peer
}

describe('reading the DeepInfra key', () => {
  it('takes fleetd’s environment first, and does not touch the file when it has one', async () => {
    let read: string | undefined
    const token = await readDeepInfraToken(
      optionsWith({
        environ: { [DEFAULT_DEEPINFRA_TOKEN_ENV]: TOKEN },
        // A file read here would mean the variable did not win.
        readText: (path) => {
          read = path
          return Promise.resolve('from-the-file')
        },
      }),
    )
    assert.equal(token, TOKEN)
    assert.equal(read, undefined)
  })

  it('falls back to the first line of the default file, under XDG config home', async () => {
    let read: string | undefined
    const token = await readDeepInfraToken(
      optionsWith({
        // Empty is not a key: v1 treated a blank `-e` as absent, and so does this.
        environ: { [DEFAULT_DEEPINFRA_TOKEN_ENV]: '   ' },
        readText: (path) => {
          read = path
          return Promise.resolve(`${TOKEN}\n# a comment the file grew later\n`)
        },
      }),
    )
    assert.equal(read, defaultDeepInfraTokenFile(CONFIG_HOME))
    assert.equal(read, `${CONFIG_HOME}/deepinfra/key`)
    assert.equal(token, TOKEN)
  })

  it('honours a profile’s own variable name and file path', async () => {
    const profile = profileWith({ providers: { deepinfra: { tokenEnv: 'MY_KEY', tokenFile: '/run/secrets/key' } } })
    assert.equal(await readDeepInfraToken(optionsWith({ profile, environ: { MY_KEY: TOKEN } })), TOKEN)

    let read: string | undefined
    assert.equal(
      await readDeepInfraToken(
        optionsWith({
          profile,
          // The default variable is not the one this profile named.
          environ: { [DEFAULT_DEEPINFRA_TOKEN_ENV]: 'from-the-wrong-variable' },
          readText: (path) => {
            read = path
            return Promise.resolve(TOKEN)
          },
        }),
      ),
      TOKEN,
    )
    assert.equal(read, '/run/secrets/key')
  })

  it('refuses a missing key with config_mismatch, naming the variable and the file and nothing else', async () => {
    const unreadable = optionsWith({
      readText: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    })
    await assert.rejects(readDeepInfraToken(unreadable), (thrown: unknown) => {
      assert.equal(code(thrown), 'config_mismatch')
      const message = (thrown as Error).message
      assert.match(message, new RegExp(DEFAULT_DEEPINFRA_TOKEN_ENV))
      assert.match(message, /\/home\/tester\/\.config\/deepinfra\/key/)
      assert.deepEqual((thrown as { details?: unknown }).details, {
        env: DEFAULT_DEEPINFRA_TOKEN_ENV,
        file: `${CONFIG_HOME}/deepinfra/key`,
      })
      return true
    })
  })

  it('refuses an empty file the same way, rather than starting a peer with an empty key', async () => {
    await assert.rejects(
      readDeepInfraToken(optionsWith({ readText: () => Promise.resolve('\n\n') })),
      (thrown: unknown) => {
        assert.equal(code(thrown), 'config_mismatch')
        assert.match((thrown as Error).message, /is empty/)
        return true
      },
    )
  })

  it('reads again at every start, so a rotated key needs no restart', async () => {
    let current = TOKEN
    const read = optionsWith({ readText: () => Promise.resolve(current) })
    assert.equal(await readDeepInfraToken(read), TOKEN)
    current = `${TOKEN}-rotated`
    assert.equal(await readDeepInfraToken(read), `${TOKEN}-rotated`)
  })
})

describe('the env a peer’s session is started with', () => {
  it('adds the endpoint, the key and the pinned model keys for a DeepInfra peer', async () => {
    const env = await createProviderEnv(optionsWith({ environ: { [DEFAULT_DEEPINFRA_TOKEN_ENV]: TOKEN } }))(
      peerOf(profileWith()),
    )
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, TOKEN)
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepinfra.com/anthropic')
    // Every alias, so a model switch inside the SDK cannot reach a Claude id.
    assert.equal(env.ANTHROPIC_MODEL, MODEL)
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, MODEL)
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, MODEL)
  })

  it('uses the profile’s endpoint when it names one', async () => {
    const profile = profileWith({ providers: { deepinfra: { baseUrl: 'https://deepinfra.staging/anthropic' } } })
    const env = await createProviderEnv(optionsWith({ profile, environ: { [DEFAULT_DEEPINFRA_TOKEN_ENV]: TOKEN } }))(
      peerOf(profile),
    )
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://deepinfra.staging/anthropic')
  })

  it('adds nothing — and reads nothing — for a peer on another provider', async () => {
    const profile = profileWith({
      peers: [{ id: 'engineer-1', role: 'engineer', provider: 'claude', model: 'claude-sonnet-5-5' }],
    })
    let raised = false
    const env = await createProviderEnv(
      optionsWith({
        profile,
        // No key anywhere: a Claude peer must not need one.
        readText: () => {
          raised = true
          return Promise.reject(new Error('should not have been read'))
        },
      }),
    )(peerOf(profile))
    assert.deepEqual(env, {})
    assert.equal(raised, false)
  })

  it('keeps the key out of a refusal: a model the adapter will not serve fails without it', async () => {
    const config: DeepInfraProviderConfig = { allowedModels: [MODEL] }
    const provider = createDeepInfraProvider(config)
    const profile = profileWith({
      // A Claude id on a DeepInfra peer: refused before anything is spawned.
      peers: [{ id: 'engineer-1', role: 'engineer', provider: 'deepinfra', model: 'claude-sonnet-5-5' }],
    })
    const env = await createProviderEnv(optionsWith({ profile, environ: { [DEFAULT_DEEPINFRA_TOKEN_ENV]: TOKEN } }))(
      peerOf(profile),
    )
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, TOKEN, 'the key is in the env this refusal is handed with')
    const peer = peerOf(profile)
    await assert.rejects(
      provider.start({
        peerId: peer.id,
        role: peer.role,
        cwd: '/tmp',
        // The id the profile gave it is the Claude id the adapter must not serve.
        model: peer.model,
        permissionMode: 'default',
        env,
        brief: { briefId: newBriefId(), version: 1, contractVersions: [], text: '' },
      }),
      (thrown: unknown) => {
        assert.equal(code(thrown), 'config_mismatch')
        assert.ok(!rendered(thrown).includes(TOKEN), 'the key is nowhere in the refusal')
        return true
      },
    )
  })
})
