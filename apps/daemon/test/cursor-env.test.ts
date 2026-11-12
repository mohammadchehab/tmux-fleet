/**
 * TASK-24: a cursor peer on a machine that is not logged in gets its key from
 * the profile's *reference* (a variable name or a file path), resolved when the
 * session starts and handed over in that one session's env — never a literal in
 * the profile, never in a message, an error detail, an event or argv.
 *
 * The key here is a string that could not be a real one, so an echo is obvious.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CURSOR_API_KEY_ENV,
  cursorKeyRouted,
  readCursorToken,
} from '../src/env/cursor-env.ts'
import { createProviderEnv, judgeEnvFor, type DeepInfraEnvOptions } from '../src/env/deepinfra-env.ts'
import { decodeProfile, type PeerProfile, type Profile } from '../src/config/profile.ts'

const KEY = 'not-a-real-cursor-key-0000'
const MODEL = 'composer-2'

const profileWith = (providers?: Record<string, unknown>, provider = 'cursor'): Profile =>
  decodeProfile({
    profile: 'engineer',
    repos: ['backbase/me-services-fleet'],
    checkouts: { 'backbase/me-services-fleet': '/work/me-services-fleet' },
    peers: [{ id: 'engineer-1', role: 'engineer', provider, model: MODEL }],
    ...(providers === undefined ? {} : { providers: { cursor: { contextLimits: { [MODEL]: 200_000 }, ...providers } } }),
  })

const optionsWith = (
  profile: Profile,
  overrides: Partial<Omit<DeepInfraEnvOptions, 'profile'>> = {},
): DeepInfraEnvOptions => ({ profile, environ: {}, configHome: '/home/tester/.config', ...overrides })

const peerOf = (profile: Profile): PeerProfile => {
  const [peer] = profile.peers
  assert.ok(peer !== undefined)
  return peer
}

const rendered = (thrown: unknown): string =>
  JSON.stringify({ message: (thrown as Error).message, ...(thrown as { details?: unknown }) })

describe('the cursor key route is opt-in, by reference', () => {
  it('is off when the profile names no tokenEnv and no tokenFile, even if the variable is set', async () => {
    const profile = profileWith({})
    const options = optionsWith(profile, { environ: { [CURSOR_API_KEY_ENV]: KEY } })
    assert.equal(cursorKeyRouted(profile), false)
    // A logged-in machine keeps its own login: the ambient key is not routed unasked.
    assert.deepEqual(await createProviderEnv(options)(peerOf(profile)), {})
  })

  it('hands the key to a cursor peer in its env, from the variable the profile names', async () => {
    const profile = profileWith({ tokenEnv: 'HETZNER_CURSOR_KEY' })
    const options = optionsWith(profile, { environ: { HETZNER_CURSOR_KEY: `  ${KEY}\n` } })
    assert.equal(cursorKeyRouted(profile), true)
    assert.deepEqual(await createProviderEnv(options)(peerOf(profile)), { [CURSOR_API_KEY_ENV]: KEY })
  })

  it('falls back to the first line of the file the profile names, read at each start', async () => {
    const profile = profileWith({ tokenFile: '/run/secrets/cursor' })
    let key = KEY
    const options = optionsWith(profile, { readText: () => Promise.resolve(`${key}\n# later lines are not the key\n`) })
    const envFor = createProviderEnv(options)
    assert.deepEqual(await envFor(peerOf(profile)), { [CURSOR_API_KEY_ENV]: KEY })
    key = 'rotated-key-0001'
    assert.deepEqual(await envFor(peerOf(profile)), { [CURSOR_API_KEY_ENV]: 'rotated-key-0001' })
  })

  it('goes to cursor peers only', async () => {
    const profile = profileWith({ tokenEnv: 'HETZNER_CURSOR_KEY' }, 'claude')
    const options = optionsWith(profile, { environ: { HETZNER_CURSOR_KEY: KEY } })
    assert.deepEqual(await createProviderEnv(options)(peerOf(profile)), {})
  })

  it('also reaches the Judge when it runs on cursor, and not otherwise', async () => {
    const profile = profileWith({ tokenEnv: 'HETZNER_CURSOR_KEY' })
    const options = optionsWith(profile, { environ: { HETZNER_CURSOR_KEY: KEY } })
    assert.deepEqual(await judgeEnvFor(options)({ provider: 'cursor', model: MODEL }), { [CURSOR_API_KEY_ENV]: KEY })
    assert.deepEqual(await judgeEnvFor(options)(undefined), {})
  })
})

describe('a route that yields no key refuses, and says nothing it should not', () => {
  it('names the file, never the variable or a value', async () => {
    const profile = profileWith({ tokenEnv: 'HETZNER_CURSOR_KEY', tokenFile: '/run/secrets/cursor' })
    const options = optionsWith(profile, {
      // The variable holds a key-shaped value, but blank: it must not be echoed either way.
      environ: { HETZNER_CURSOR_KEY: '   ' },
      readText: () => Promise.reject(Object.assign(new Error(`ENOENT ${KEY}`), { code: 'ENOENT' })),
    })
    await assert.rejects(readCursorToken(options), (thrown: unknown) => {
      assert.equal((thrown as { code?: string }).code, 'config_mismatch')
      const text = rendered(thrown)
      assert.doesNotMatch(text, /HETZNER_CURSOR_KEY/)
      assert.match(text, /\/run\/secrets\/cursor/)
      assert.equal(text.includes(KEY), false, 'the underlying error text is a cause, not a message')
      return true
    })
  })

  it('refuses an empty file rather than starting a peer with an empty key', async () => {
    const profile = profileWith({ tokenFile: '/run/secrets/cursor' })
    await assert.rejects(readCursorToken(optionsWith(profile, { readText: () => Promise.resolve('\n\n') })), /is empty/)
  })
})

describe('the profile holds a reference, not a literal', () => {
  it('decodes tokenEnv and tokenFile, and still refuses an unknown key in the block', () => {
    const profile = profileWith({ tokenEnv: 'X', tokenFile: '/y' })
    assert.equal(profile.providers?.cursor?.tokenEnv, 'X')
    assert.equal(profile.providers?.cursor?.tokenFile, '/y')
    assert.throws(() => profileWith({ apiKey: KEY }), /apiKey|unknown/i)
  })
})
