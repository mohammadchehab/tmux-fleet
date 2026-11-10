/**
 * The conformance suite has to be able to fail (architecture §4, §1.1
 * `tests/conformance/providers`). A stub provider that declares itself
 * honestly passes; one that lies about what it can do is caught before it is
 * registered, not after a peer's session silently degrades.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fleetError, type TurnId } from '@fleet/foundation-core'
import type { ProviderCapabilities, ProviderSessionRef, SessionSpec } from '@fleet/foundation-contracts'
import type { SessionHandle } from '../src/index.ts'
import { capabilityChecks, resumeChecks, type Provider } from '../src/index.ts'

const handle = (providerId = 'stub'): SessionHandle => ({
  sessionId: 'ses_1a2b3c4d5e6f7081',
  sessionRef: 'sess_9f8e7d6c5b4a39281706' as ProviderSessionRef,
  peerId: 'engineer-1',
  providerId,
  model: 'stub-model',
  permissionMode: 'default',
  briefTurnId: 'trn_0123456789abcdef' as TurnId,
})

const spec = (): SessionSpec =>
  ({
    peerId: 'engineer-1',
    role: 'engineer-1',
    cwd: '/tmp/fleet',
    model: 'stub-model',
    permissionMode: 'default',
    env: {},
    brief: {},
  }) as unknown as SessionSpec

const stub = (id: string, capabilities: Partial<ProviderCapabilities>): Provider => {
  let switchedTo: string | undefined
  return {
  id,
  capabilities: {
    resume: true,
    modelSwitch: true,
    usageTokens: true,
    usageCost: true,
    structuredOutput: false,
    permissionModes: ['default'],
    ...capabilities,
  },
  start: async () => handle(id),
  send: async () => 'trn_8192a3b4c5d6e7f8' as TurnId,
  interrupt: async () => {},
  answer: async () => {},
  respond: async () => {},
  stop: async () => {},
  status: async () => 'idle',
  usage: async () =>
    capabilities.usageCost === false
      ? { contextTokens: 0, contextLimit: 200_000 }
      : { contextTokens: 0, contextLimit: 200_000, costUsd: 0 },
  model: async () => ({ id: switchedTo ?? 'stub-model' }),
  setModel: async (_handle, model) => {
    if (capabilities.modelSwitch === false) throw fleetError('unsupported', 'stub cannot switch models')
    switchedTo = model
  },
  events: async function* () {
    return
  },
  // Honest by default: resume only succeeds when the provider declared it can.
  resume: async () => {
    if (capabilities.resume === false) throw fleetError('unsupported', 'stub cannot resume')
    return handle(id)
  },
  }
}

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

/** Resume is a promise only a call can break, so these checks need a session. */
const resumeFailures = async (provider: Provider): Promise<string[]> => {
  const started = await provider.start(spec())
  const results = await Promise.all(
    resumeChecks().map(async (check) => ({ check, failure: await check.run({ provider, handle: started, spec: spec() }) })),
  )
  return results.filter((r) => r.failure !== null).map((r) => `${r.check.name}: ${r.failure}`)
}

test('a provider that can resume passes the resume check', async () => {
  assert.deepEqual(await resumeFailures(stub('claude-code', { resume: true })), [])
})

test('a provider that declares no resume and rejects unsupported passes', async () => {
  assert.deepEqual(await resumeFailures(stub('plain-cli', { resume: false })), [])
})

test('a provider that resumes although it declared it cannot is caught', async () => {
  const liar = { ...stub('liar', { resume: false }), resume: async () => handle('liar') }
  const caught = await resumeFailures(liar)
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /returned a session although capabilities\.resume is false/)
})

test('a provider that refuses a resume it declared is caught', async () => {
  const broken = {
    ...stub('broken', { resume: true }),
    resume: async () => {
      throw fleetError('provider_failed', 'the vendor lost the session')
    },
  }
  const caught = await resumeFailures(broken)
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /although capabilities\.resume is true/)
})

test('a provider that invents a cost it declared it cannot know is caught', async () => {
  const priced = {
    ...stub('priced', { usageCost: false }),
    usage: async () => ({ contextTokens: 0, contextLimit: 200_000, costUsd: 0.42 }),
  }
  const caught = await resumeFailures(priced)
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /reported costUsd although capabilities\.usageCost is false/)
})

test('a provider that hides a cost it declared is caught', async () => {
  const silent = {
    ...stub('silent', { usageCost: true }),
    usage: async () => ({ contextTokens: 0, contextLimit: 200_000 }),
  }
  const caught = await resumeFailures(silent)
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /omitted costUsd although capabilities\.usageCost is true/)
})

test('a provider that refuses with the wrong code is caught', async () => {
  const sloppy = {
    ...stub('sloppy', { resume: false }),
    resume: async () => {
      throw fleetError('provider_failed', 'not implemented')
    },
  }
  const caught = await resumeFailures(sloppy)
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /must reject FleetError\('unsupported'\)/)
})

test('a provider that switches models as declared passes the setModel check', async () => {
  assert.deepEqual(await resumeFailures(stub('claude-code', { modelSwitch: true })), [])
})

test('a provider that cannot switch models and rejects unsupported passes', async () => {
  assert.deepEqual(await resumeFailures(stub('plain-cli', { modelSwitch: false })), [])
})

test('a provider that switches although it declared it cannot is caught', async () => {
  const liar = { ...stub('liar', { modelSwitch: false }), setModel: async () => {} }
  const caught = await resumeFailures(liar)
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /succeeded although capabilities\.modelSwitch is false/)
})

test('a provider that refuses a switch it declared is caught', async () => {
  const broken = {
    ...stub('broken', { modelSwitch: true }),
    setModel: async () => {
      throw fleetError('provider_failed', 'the vendor refused')
    },
  }
  const caught = await resumeFailures(broken)
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /rejected with provider_failed although capabilities\.modelSwitch is true/)
})

test('a provider whose model() ignores the switch is caught', async () => {
  const stale = { ...stub('stale', { modelSwitch: true }), setModel: async () => {}, model: async () => ({ id: 'stub-model' }) }
  const caught = await resumeFailures(stale)
  assert.equal(caught.length, 1)
  assert.match(caught[0] ?? '', /it must report the requested model/)
})
