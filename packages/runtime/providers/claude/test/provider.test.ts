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

import type { TurnId } from '@fleet/foundation-core'
import { capabilityChecks, type Provider } from '@fleet/runtime-provider-sdk'

import { ClaudeProvider } from '../src/index.ts'

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
    structuredOutput: true,
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  })
})

test('a second provider on the same SDK is the same class with another id', () => {
  const deepinfra = new ClaudeProvider({
    id: 'deepinfra',
    limits: { byModel: { 'deepseek-ai/DeepSeek-V4.1-Flash-1017': 1_048_576 }, fallback: 1_048_576 },
    usageCost: false,
  })
  assert.equal(deepinfra.id, 'deepinfra')
  assert.equal(deepinfra.capabilities.usageTokens, true)
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
  assert.throws(
    () => fresh.answer(handle, 'yes', 'qst_0123456789abcdef'),
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
