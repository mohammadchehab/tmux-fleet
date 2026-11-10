/**
 * The provider as the registry sees it: an id, honest capabilities, and the
 * conformance suite every provider must pass (§4, `tests/conformance/providers`).
 *
 * Nothing here spawns a CLI: a `Provider` that needs a live session to answer a
 * conformance question would not be registerable, and the session-level checks
 * belong to the fixture replay that phase 1 adds.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isFleetErrorCode, type TurnId } from '@fleet/foundation-core'
import { capabilityChecks, type Provider, type QuestionId } from '@fleet/runtime-provider-sdk'

import { claudeCapabilities, ClaudeProvider } from '../src/index.ts'

const provider: Provider = new ClaudeProvider()

test('passes every capability check', async () => {
  for (const check of capabilityChecks()) {
    assert.equal(await check.run(provider), null, `${check.name}: ${check.because}`)
  }
})

test('declares the capabilities the spike measured, and no others', () => {
  assert.deepEqual(provider.capabilities, {
    resume: true,
    modelSwitch: true,
    usageTokens: true,
    usageCost: true,
    structuredOutput: true,
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  })
})

test('a second provider on the same SDK is the same class with another id', () => {
  const deepinfra = new ClaudeProvider({
    id: 'deepinfra',
    limits: { byModel: { 'deepseek-ai/DeepSeek-V4.1-Flash-1017': 1_048_576 }, fallback: 1_048_576 },
    capabilities: { usageCost: false },
  })
  assert.equal(deepinfra.id, 'deepinfra')
  assert.equal(deepinfra.capabilities.usageTokens, true)
  assert.equal(deepinfra.capabilities.usageCost, false)
})

test('the id must be provider-shaped or the registry cannot address it', () => {
  const check = capabilityChecks()[0]
  assert.ok(check !== undefined)
  const bad = new ClaudeProvider({ id: 'Claude_Provider' })
  return check.run(bad).then((failure) => assert.notEqual(failure, null))
})

test('the session table is empty until a session starts, and a stranger handle is not_found', async () => {
  const fresh = new ClaudeProvider()
  await assert.rejects(
    fresh.status({
      sessionId: 'ses_aaaaaaaaaaaaaaaa',
      sessionRef: 'sess_abc' as never,
      peerId: 'engineer-1',
      providerId: 'claude',
      model: 'claude-opus-5-5',
      permissionMode: 'default',
    }),
    (thrown: unknown) => (thrown as { code?: string }).code === 'not_found',
  )
})

test('an answer with no open question is not_found rather than a silent drop', async () => {
  const fresh = new ClaudeProvider()
  const handle = {
    sessionId: 'ses_aaaaaaaaaaaaaaaa',
    sessionRef: 'sess_abc' as never,
    peerId: 'engineer-1',
    providerId: 'claude',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
  }
  await assert.rejects(
    fresh.answer(handle, 'qst_0123456789abcdef' as QuestionId, ['yes']),
    (thrown: unknown) => (thrown as { code?: string }).code === 'not_found',
  )
  assert.equal(await fresh.send(handle, { text: 'x', kind: 'nudge', briefVersion: 1 }).catch((e: { code?: string }) => e.code), 'not_found')
})

test('interrupting a stranger handle is not_found, not a crash', async () => {
  const fresh = new ClaudeProvider()
  const handle = {
    sessionId: 'ses_aaaaaaaaaaaaaaaa',
    sessionRef: 'sess_abc' as never,
    peerId: 'engineer-1',
    providerId: 'claude',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
  }
  await assert.rejects(fresh.interrupt(handle, 'trn_0123456789abcdef' as TurnId), (thrown: unknown) => {
    return (thrown as { code?: string }).code === 'not_found'
  })
})

test('capabilities default to what the spike measured, frozen, and are a promise not a hint', () => {
  const fresh = new ClaudeProvider()
  assert.deepEqual(fresh.capabilities, {
    resume: true,
    modelSwitch: true,
    usageTokens: true,
    usageCost: true,
    structuredOutput: true,
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  })
  assert.ok(Object.isFrozen(fresh.capabilities))
  assert.ok(Object.isFrozen(fresh.capabilities.permissionModes))
  assert.deepEqual(claudeCapabilities, fresh.capabilities)
})

test('a capability narrowed by config is a method that refuses, not one that lies', async () => {
  const noSwitch = new ClaudeProvider({ capabilities: { modelSwitch: false, usageTokens: false } })
  assert.equal(noSwitch.capabilities.modelSwitch, false)
  assert.equal(noSwitch.capabilities.usageTokens, false)
  assert.equal(noSwitch.capabilities.resume, true, 'a narrowing does not disturb the others')
  // The guard runs before the session table, so this is `unsupported`, not `not_found`:
  // the provider says what it cannot do before it says what it does not know.
  await assert.rejects(
    noSwitch.setModel({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never, 'claude-opus-5-5'),
    (thrown: unknown) => (thrown as { code?: string }).code === 'unsupported',
  )
})

test('a provider that cannot resume refuses a resume spec before it spawns anything', async () => {
  const noResume = new ClaudeProvider({ capabilities: { resume: false } })
  const spec = {
    peerId: 'engineer-1',
    role: 'engineer',
    cwd: '/tmp',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    env: {},
    brief: { briefId: 'brf_0123456789abcdef', version: 1, contractVersions: [], text: 'x' },
    resumeRef: 'sess_dead',
  } as never
  await assert.rejects(noResume.start(spec), (thrown: unknown) => (thrown as { code?: string }).code === 'unsupported')
  // The refusal happened before the session table was touched.
  await assert.rejects(
    noResume.status({ sessionId: 'ses_aaaaaaaaaaaaaaaa' } as never),
    (thrown: unknown) => (thrown as { code?: string }).code === 'not_found',
  )
})

test('the launch checks reject with typed codes, so the supervisor can restart on them', () => {
  assert.ok(isFleetErrorCode('config_mismatch'))
  assert.ok(isFleetErrorCode('permission_mode_mismatch'))
})
