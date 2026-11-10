/**
 * What the cursor provider refuses, and that its capabilities tell the truth (§4,
 * §13). The refusals matter more than the happy path here: a fleet tool that
 * quietly starts a writing peer, or a session on a model whose window it does not
 * know, is worse than one that will not start.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { capabilityChecks } from '@fleet/runtime-provider-sdk'
import type { PeerId } from '@fleet/foundation-core'
import type { SessionHandle, SessionSpec } from '@fleet/runtime-provider-sdk'

import { CursorProvider, createCursorProvider, cursorCapabilities } from '../src/provider.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-cursor-agent.mjs', import.meta.url))
const MODEL = 'composer-2.5'

const provider = (): CursorProvider =>
  new CursorProvider({
    executable: process.execPath,
    executableArgs: [FAKE],
    contextLimits: { [MODEL]: 200_000 },
  })

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  peerId: 'peer-1' as PeerId,
  role: 'engineer',
  cwd: mkdtempSync(join(tmpdir(), 'fleet-cursor-')),
  model: MODEL,
  permissionMode: 'plan',
  env: {},
  brief: { briefId: 'brf_00000000000000aa' as SessionSpec['brief']['briefId'], version: 1, contractVersions: [], text: 'Build the thing.' },
  ...over,
})

const code = (thrown: unknown): string | undefined => (thrown as { code?: string }).code

test('the provider passes every capability check', async () => {
  for (const check of capabilityChecks()) {
    assert.equal(await check.run(provider()), null, `${check.name}: ${check.because}`)
  }
})

test('it declares itself read-only, with no cost and no schema', () => {
  assert.deepEqual(cursorCapabilities, {
    resume: true,
    modelSwitch: true,
    usageTokens: true,
    usageCost: false,
    structuredOutput: false,
    permissionModes: ['plan'],
  })
})

test('a session in any mode but plan is refused before anything spawns', async () => {
  const subject = provider()
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
    await assert.rejects(
      () => subject.start(spec({ permissionMode: mode })),
      (thrown: unknown) => {
        assert.equal(code(thrown), 'unsupported')
        const message = (thrown as Error).message
        assert.match(message, /read-only/, 'the refusal says what the provider is')
        assert.match(message, /no tool policy standing between it and the files/, 'and why the mode is the guarantee')
        assert.doesNotMatch(message, /§/, 'no user-facing string cites a section')
        return true
      },
    )
  }
})

test('the "auto" model is refused: a session must be able to say what it runs', async () => {
  await assert.rejects(
    () => provider().start(spec({ model: 'auto' })),
    (thrown: unknown) => code(thrown) === 'invalid_input' && /display name/.test((thrown as Error).message),
  )
})

test('a model with no configured window is refused rather than given a guess', async () => {
  await assert.rejects(
    () => provider().start(spec({ model: 'gpt-5.6-sol-high' })),
    (thrown: unknown) =>
      code(thrown) === 'invalid_input' && /no context limit configured for cursor model gpt-5\.6-sol-high/.test((thrown as Error).message),
  )
})

test('MCP servers are refused, not silently dropped', async () => {
  await assert.rejects(
    () => provider().start(spec({ mcp: [{ id: 'codegraph', command: 'codegraph' }] })),
    (thrown: unknown) => code(thrown) === 'unsupported' && /do not wire MCP servers/.test((thrown as Error).message),
  )
})

test('answer() and respond() reject unsupported: a plan-mode session asks nobody', async () => {
  const subject = provider()
  const handle = await subject.start(spec())
  await assert.rejects(
    () => subject.answer(handle, 'qst_00000000000000aa' as Parameters<typeof subject.answer>[1], []),
    (thrown: unknown) => code(thrown) === 'unsupported',
  )
  await assert.rejects(
    () => subject.respond(handle, 'req-1', 'allow'),
    (thrown: unknown) => code(thrown) === 'unsupported',
  )
  await subject.stop(handle)
})

test('a handle this provider never started is not found, not a new session', async () => {
  const subject = provider()
  const stranger: SessionHandle = {
    sessionId: 'ses_0000000000000000',
    sessionRef: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as SessionHandle['sessionRef'],
    peerId: 'peer-1',
    providerId: 'cursor',
    model: MODEL,
    permissionMode: 'plan',
    briefTurnId: 'trn_0000000000000000' as SessionHandle['briefTurnId'],
  }
  await assert.rejects(
    () => subject.status(stranger),
    (thrown: unknown) => code(thrown) === 'not_found',
  )
})

test('setModel refuses the same models a start does', async () => {
  const subject = provider()
  const handle = await subject.start(spec())
  await assert.rejects(
    () => subject.setModel(handle, 'auto'),
    (thrown: unknown) => code(thrown) === 'invalid_input',
  )
  await subject.stop(handle)
})

test('the factory gives back a Provider, so a registry can hold it without the class', () => {
  const built = createCursorProvider({ contextLimits: { [MODEL]: 200_000 } })
  assert.equal(built.id, 'cursor')
  assert.deepEqual(built.capabilities.permissionModes, ['plan'])
})
