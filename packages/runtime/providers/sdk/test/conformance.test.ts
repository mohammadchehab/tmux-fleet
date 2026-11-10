/**
 * The conformance suite has to be able to fail (architecture §4, §1.1
 * `tests/conformance/providers`). A stub provider that declares itself
 * honestly passes; one that lies about what it can do is caught before it is
 * registered, not after a peer's session silently degrades.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TurnId } from '@fleet/foundation-core'
import type { ProviderCapabilities, ProviderSessionRef } from '@fleet/foundation-contracts'
import type { SessionHandle } from '../src/index.ts'
import { capabilityChecks, type Provider } from '../src/index.ts'

const handle = (): SessionHandle => ({
  sessionId: 'ses_1a2b3c4d5e6f7081',
  sessionRef: 'sess_9f8e7d6c5b4a39281706' as ProviderSessionRef,
  peerId: 'engineer-1',
  providerId: 'stub',
  model: 'stub-model',
  permissionMode: 'default',
})

const stub = (id: string, capabilities: Partial<ProviderCapabilities>): Provider => ({
  id,
  capabilities: {
    resume: true,
    modelSwitch: true,
    usageTokens: true,
    structuredOutput: false,
    permissionModes: ['default'],
    ...capabilities,
  },
  start: async () => handle(),
  send: async () => 'trn_8192a3b4c5d6e7f8' as TurnId,
  interrupt: async () => {},
  stop: async () => {},
  status: async () => 'idle',
  usage: async () => ({ contextTokens: 0, contextLimit: 200_000 }),
  model: async () => ({ id: 'stub-model' }),
  events: async function* () {
    return
  },
  resume: async () => handle(),
})

const failures = async (provider: Provider): Promise<string[]> => {
  const results = await Promise.all(capabilityChecks().map(async (check) => ({ check, failure: await check.run(provider) })))
  return results.filter((r) => r.failure !== null).map((r) => `${r.check.name}: ${r.failure}`)
}

test('an honest provider passes every capability check', async () => {
  assert.deepEqual(await failures(stub('claude-code', {})), [])
})

test('a provider that cannot resume is still honest', async () => {
  assert.deepEqual(await failures(stub('plain-cli', { resume: false, usageTokens: false })), [])
})

test('a malformed id is caught', async () => {
  const caught = await failures(stub('Claude Code', {}))
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /not provider-shaped/)
})

test('a capability left undeclared is caught', async () => {
  const provider = stub('half', {})
  delete (provider.capabilities as { resume?: boolean }).resume
  const caught = await failures(provider)
  // Two checks read `resume`, so both fire; either one refusing the provider is enough.
  assert.ok(caught.length >= 1)
  assert.ok(caught.some((failure) => failure.startsWith('declares every capability explicitly')))
  assert.ok(caught.every((failure) => failure.includes('resume')))
})

test('an empty permission-mode set is caught', async () => {
  const caught = await failures(stub('no-modes', { permissionModes: [] }))
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /permissionModes is empty/)
})

test('a repeated permission mode is caught', async () => {
  const caught = await failures(stub('dup-modes', { permissionModes: ['default', 'default'] }))
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /repeats a mode/)
})
