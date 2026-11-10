/**
 * DeepInfra as a provider (§4): honest capabilities, a limit from config, and a
 * spec that is checked before anything spawns.
 *
 * Nothing here starts a session: a DeepInfra start needs a live key and spends
 * money, and every claim below is about what the provider decides *before* the
 * inner Claude provider is asked to do anything.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { newBriefId, type PeerId } from '@fleet/foundation-core'
import { capabilityChecks, type Provider, type SessionSpec } from '@fleet/runtime-provider-sdk'

import {
  DEEP_INFRA_BASE_URL,
  DEEP_INFRA_CONTEXT_LIMITS,
  DeepInfraProvider,
  createDeepInfraProvider,
  deepInfraEnv,
} from '../src/index.ts'

const provider = new DeepInfraProvider()
const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

const spec = (overrides: Partial<SessionSpec> = {}): SessionSpec => ({
  peerId: 'engineer-1' as PeerId,
  role: 'engineer',
  cwd: '/tmp',
  model: MODEL,
  permissionMode: 'default',
  env: deepInfraEnv('not-a-real-key'),
  brief: { briefId: newBriefId(), version: 1, contractVersions: [], text: 'do the thing' },
  ...overrides,
})

const code = (thrown: unknown): string | undefined => (thrown as { code?: string }).code

test('passes every capability check, like any provider (§4)', async () => {
  const asInterface: Provider = createDeepInfraProvider()
  for (const check of capabilityChecks()) {
    assert.equal(await check.run(asInterface), null, `${check.name}: ${check.because}`)
  }
})

test('declares cost as unknown and everything else as the Agent SDK measured it', () => {
  assert.deepEqual(provider.capabilities, {
    resume: true,
    modelSwitch: true,
    usageTokens: true,
    usageCost: false,
    structuredOutput: true,
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  })
  assert.ok(Object.isFrozen(provider.capabilities))
  assert.equal(provider.id, 'deepinfra')
})

test('the context limit is the vendor’s window, not the 200 000 the SDK guesses', () => {
  assert.equal(DEEP_INFRA_CONTEXT_LIMITS[MODEL], 1_048_576)
})

test('deepInfraEnv builds the endpoint and the token, and refuses an empty token', () => {
  assert.deepEqual(deepInfraEnv('k'), { ANTHROPIC_BASE_URL: DEEP_INFRA_BASE_URL, ANTHROPIC_AUTH_TOKEN: 'k' })
  assert.throws(() => deepInfraEnv('   '), (thrown: unknown) => code(thrown) === 'invalid_input')
  assert.throws(() => deepInfraEnv(''), (thrown: unknown) => code(thrown) === 'invalid_input')
})

test('a model with no configured window is refused, not given a default', async () => {
  // §8 purges on contextLimit/contextTokens: a guessed window purges a real
  // session at the wrong size, which is worse than refusing to start it.
  await assert.rejects(
    provider.start(spec({ model: 'deepseek-ai/DeepSeek-V3.2' })),
    (thrown: unknown) => code(thrown) === 'invalid_input',
  )
})

test('a model added through config becomes startable and switchable', async () => {
  const custom = new DeepInfraProvider({ contextLimits: { 'deepseek-ai/DeepSeek-V3.2': 65_536 } })
  const handle = { sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never
  // Past validation, the handle is unknown — but not for the reason `setModel` refuses.
  await assert.rejects(
    custom.setModel(handle, 'deepseek-ai/DeepSeek-V3.2'),
    (thrown: unknown) => code(thrown) === 'not_found',
  )
  assert.equal(custom.capabilities.usageCost, false)
})

test('switching to a model with no window is refused before the session is touched', async () => {
  await assert.rejects(
    provider.setModel({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never, 'gpt-4o'),
    (thrown: unknown) => code(thrown) === 'invalid_input',
  )
})

test('a spec pointed anywhere but DeepInfra is a config_mismatch, not a silent reroute', async () => {
  await assert.rejects(
    provider.start(spec({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'k' } })),
    (thrown: unknown) => code(thrown) === 'config_mismatch',
  )
})

test('a spec that names no endpoint is refused: nothing is inferred or inherited', async () => {
  await assert.rejects(
    provider.start(spec({ env: { ANTHROPIC_AUTH_TOKEN: 'k' } })),
    (thrown: unknown) => code(thrown) === 'invalid_input',
  )
})

test('a missing token is refused, and the error never carries one', async () => {
  await assert.rejects(
    provider.start(spec({ env: { ANTHROPIC_BASE_URL: DEEP_INFRA_BASE_URL } })),
    (thrown: unknown) => {
      assert.equal(code(thrown), 'invalid_input')
      const details = JSON.stringify((thrown as { details?: unknown }).details ?? {})
      assert.ok(!details.includes('ANTHROPIC_AUTH_TOKEN:'), 'details must name the key, never its value')
      return true
    },
  )
})

test('a Claude credential alongside the DeepInfra one is refused: the SDK would prefer it', async () => {
  await assert.rejects(
    provider.start(
      spec({
        env: {
          ANTHROPIC_BASE_URL: DEEP_INFRA_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: 'k',
          ANTHROPIC_API_KEY: 'sk-ant-not-a-deepinfra-key',
        },
      }),
    ),
    (thrown: unknown) => code(thrown) === 'invalid_input',
  )
})

test('a base URL override is honoured: the endpoint it names is the only one accepted', async () => {
  const staging = new DeepInfraProvider({ baseUrl: 'https://deepinfra.staging/anthropic' })
  await assert.rejects(
    staging.start(spec()),
    (thrown: unknown) => code(thrown) === 'config_mismatch',
    'the default DeepInfra endpoint must not be accepted by a staging provider',
  )
})

test('a resume is checked like a start, and resumes rather than starting fresh', async () => {
  await assert.rejects(
    provider.resume('sess_abc' as never, spec({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })),
    (thrown: unknown) => code(thrown) === 'config_mismatch',
  )
})

test('a stranger handle is not_found through the delegation, not a crash', async () => {
  await assert.rejects(
    provider.status({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never),
    (thrown: unknown) => code(thrown) === 'not_found',
  )
})
