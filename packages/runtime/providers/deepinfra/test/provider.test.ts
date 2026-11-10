/**
 * DeepInfra as a provider (§4): honest capabilities, a limit from config, and a
 * spec that is checked before anything spawns.
 *
 * Nothing here starts a session: a DeepInfra start needs a live key and spends
 * money, and every claim below is about what the provider decides *before* the
 * inner Claude provider is asked to do anything. The one thing the provider does
 * *to* a spec on its way through — pinning every model key — is `pinModelEnv`,
 * so it is tested where it is pure rather than by spawning.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { newBriefId, type PeerId } from '@fleet/foundation-core'
import { capabilityChecks, type Provider, type SessionSpec } from '@fleet/runtime-provider-sdk'

import {
  DEEP_INFRA_BASE_URL,
  DEEP_INFRA_CONTEXT_LIMITS,
  DEEP_INFRA_MODEL_ENV_KEYS,
  DeepInfraProvider,
  createDeepInfraProvider,
  deepInfraCapabilities,
  deepInfraEnv,
  narrowCapabilities,
  pinModelEnv,
} from '../src/index.ts'

const provider = new DeepInfraProvider()
const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

const spec = (overrides: Partial<SessionSpec> = {}): SessionSpec => ({
  peerId: 'engineer-1' as PeerId,
  role: 'engineer',
  cwd: '/tmp',
  model: MODEL,
  permissionMode: 'default',
  env: deepInfraEnv('not-a-real-key', { model: MODEL }),
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

test('capabilities may be narrowed, never widened', () => {
  // A capability is what the supervisor plans around: `usageCost: true` would
  // put SDK-priced dollars in the §11 ledger as if the vendor had priced them,
  // which is exactly the number this provider exists to refuse. So narrowing is
  // honoured and widening is refused at construction, not silently merged.
  const narrowed = new DeepInfraProvider({
    capabilities: { structuredOutput: false, permissionModes: ['default'] },
  })
  assert.deepEqual(narrowed.capabilities, {
    resume: true,
    modelSwitch: true,
    usageTokens: true,
    usageCost: false,
    structuredOutput: false,
    permissionModes: ['default'],
  })
  assert.ok(Object.isFrozen(narrowed.capabilities))
  assert.ok(Object.isFrozen(narrowed.capabilities.permissionModes))

  assert.throws(
    () => new DeepInfraProvider({ capabilities: { usageCost: true } }),
    (thrown: unknown) => code(thrown) === 'invalid_input',
  )
  // A mode can only be taken away, never added back: the base honours all four,
  // so the case is only reachable once something has narrowed them.
  const narrowedModes = narrowCapabilities(deepInfraCapabilities, { permissionModes: ['default'] })
  assert.throws(
    () => narrowCapabilities(narrowedModes, { permissionModes: ['default', 'plan'] }),
    (thrown: unknown) => code(thrown) === 'invalid_input',
  )
  assert.deepEqual(
    narrowCapabilities(narrowedModes, { permissionModes: ['default'] }).permissionModes,
    ['default'],
  )
})

test('the context limit is the vendor’s window, not the 200 000 the SDK guesses', () => {
  assert.equal(DEEP_INFRA_CONTEXT_LIMITS[MODEL], 1_048_576)
})

test('the window a session is told about is the one this endpoint will report (§6.2, §8)', () => {
  // The Stop hook's `FLEET_CONTEXT_LIMIT` and `usage().contextLimit` are the
  // same number or the projection and the purge disagree about the same turn.
  assert.equal(provider.contextLimit(MODEL), DEEP_INFRA_CONTEXT_LIMITS[MODEL])
  // An unlisted model has no window here: the session carries no limit and the
  // hook skips, rather than being handed the SDK's 200 000 guess.
  assert.equal(provider.contextLimit('some-vendor/unlisted-model'), undefined)
})

test('deepInfraEnv builds the endpoint, the token and the model, and refuses an empty token', () => {
  assert.deepEqual(deepInfraEnv('k', { model: MODEL }), {
    ANTHROPIC_BASE_URL: DEEP_INFRA_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: 'k',
    ...pinModelEnv(MODEL),
  })
  assert.throws(() => deepInfraEnv('   ', { model: MODEL }), (thrown: unknown) => code(thrown) === 'invalid_input')
  assert.throws(() => deepInfraEnv('', { model: MODEL }), (thrown: unknown) => code(thrown) === 'invalid_input')
})

test('every key the SDK resolves a model from is pinned, so no alias falls through to Claude', () => {
  // The spike watched `anthropic/claude-sonnet-5-5` reach DeepInfra: the CLI
  // validates nothing. The aliases are the quiet half of that problem — an
  // unset ANTHROPIC_SMALL_FAST_MODEL is a Claude id by default, so a background
  // summarisation would leave for Anthropic and the stream would never say so.
  const pinned = pinModelEnv(MODEL)
  assert.deepEqual([...DEEP_INFRA_MODEL_ENV_KEYS].sort(), [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
  ])
  for (const key of DEEP_INFRA_MODEL_ENV_KEYS) {
    assert.equal(pinned[key], MODEL, `${key} must point at the spec's model`)
  }
  assert.ok(Object.isFrozen(pinned))
})

test('a Claude model id is a config_mismatch before anything spawns, however it is spelled', async () => {
  for (const model of ['claude-sonnet-5-5', 'claude-3-5-haiku-20241022', 'anthropic/claude-sonnet-5-5']) {
    await assert.rejects(
      provider.start(spec({ model })),
      (thrown: unknown) => code(thrown) === 'config_mismatch',
      `${model} names a vendor this endpoint is not`,
    )
    await assert.rejects(
      provider.resume('sess_abc' as never, spec({ model })),
      (thrown: unknown) => code(thrown) === 'config_mismatch',
      `a resume is checked like a start: ${model}`,
    )
  }
})

test('switching a live session to a Claude id is refused by the same rule', async () => {
  // Otherwise the switch is the one path that skips the start-time check, and a
  // running session quietly becomes a Claude session with a DeepInfra token.
  await assert.rejects(
    provider.setModel({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never, 'anthropic/claude-sonnet-5-5'),
    (thrown: unknown) => code(thrown) === 'config_mismatch',
  )
})

test('an allowlist pins the profile to a set of DeepInfra ids, and refuses the rest', async () => {
  const allowed = new DeepInfraProvider({
    allowedModels: [MODEL],
    contextLimits: { 'deepseek-ai/DeepSeek-V3.2': 65_536 },
  })
  // On the allowlist and past validation: the refusal is the unknown handle, not the model.
  await assert.rejects(
    allowed.setModel({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never, MODEL),
    (thrown: unknown) => code(thrown) === 'not_found',
  )
  // A real DeepInfra model with a configured window, but not one this profile may use.
  await assert.rejects(
    allowed.start(spec({ model: 'deepseek-ai/DeepSeek-V3.2' })),
    (thrown: unknown) => code(thrown) === 'config_mismatch',
  )
  await assert.rejects(
    allowed.setModel({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never, 'deepseek-ai/DeepSeek-V3.2'),
    (thrown: unknown) => code(thrown) === 'config_mismatch',
  )
  // No allowlist, same spec: the model is merely unconfigured here, which is a different refusal.
  const open = new DeepInfraProvider({ contextLimits: { 'deepseek-ai/DeepSeek-V3.2': 65_536 } })
  await assert.rejects(
    open.setModel({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never, 'deepseek-ai/DeepSeek-V3.2'),
    (thrown: unknown) => code(thrown) === 'not_found',
  )
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
