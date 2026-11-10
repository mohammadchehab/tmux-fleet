/**
 * The env rule (§4, §13). `Options.env` replaces the child environment, so the
 * two failures this test pins are the two the spike reproduced:
 *
 * - a parent's `ANTHROPIC_*` / `CLAUDE_CODE_*` must never reach a peer by
 *   inheritance, or a "claude" session runs on the fleet process's endpoint;
 * - a spec's own endpoint must reach it, because that is how a provider is
 *   pointed somewhere else at all.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PeerId } from '@fleet/foundation-core'

import { buildChildEnv, recordedEndpoint, recordedModel } from '../src/index.ts'

const peer = 'engineer-1' as PeerId

const parent = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/peer',
  LANG: 'en_GB.UTF-8',
  ANTHROPIC_API_KEY: 'sk-fleet-process',
  ANTHROPIC_BASE_URL: 'https://api.deepinfra.com/anthropic',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDECODE: '1',
  AWS_SECRET_ACCESS_KEY: 'not-on-the-allowlist',
} as const

test('inherits exactly the process variables on the allowlist', () => {
  const built = buildChildEnv({ peerId: peer, env: {} }, parent)
  assert.deepEqual(Object.keys(built.env).sort(), ['HOME', 'LANG', 'PATH'])
  assert.deepEqual(built.inherited, ['HOME', 'LANG', 'PATH'])
})

test('withholds every parent variable that names a model, an endpoint or a secret', () => {
  const built = buildChildEnv({ peerId: peer, env: {} }, parent)
  assert.equal(built.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(built.env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(built.env.CLAUDECODE, undefined)
  assert.equal(built.env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.deepEqual(built.withheld, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'])
})

test('a spec decides its own endpoint and model, and they are not reported as withheld', () => {
  const built = buildChildEnv(
    {
      peerId: peer,
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepinfra.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        ANTHROPIC_AUTH_TOKEN: 'spec-key',
      },
    },
    parent,
  )
  assert.equal(built.env.ANTHROPIC_BASE_URL, 'https://api.deepinfra.com/anthropic')
  assert.equal(built.env.ANTHROPIC_MODEL, 'deepseek-ai/DeepSeek-V4.1-Flash-1017')
  // The parent's key is still withheld: the spec's token replaced it.
  assert.deepEqual(built.withheld, ['ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'])
  assert.equal(recordedEndpoint(built.env), 'https://api.deepinfra.com/anthropic')
  assert.equal(recordedModel(built.env), 'deepseek-ai/DeepSeek-V4.1-Flash-1017')
})

test('a spec value wins over an inherited one', () => {
  const built = buildChildEnv({ peerId: peer, env: { LANG: 'C' } }, parent)
  assert.equal(built.env.LANG, 'C')
})

test('the built env is frozen: a later mutation cannot drift a running session', () => {
  const built = buildChildEnv({ peerId: peer, env: {} }, parent)
  assert.throws(() => {
    ;(built.env as Record<string, string>).PATH = '/nowhere'
  })
})

test('an env with no PATH is the caller bug it is, not a provider failure', () => {
  assert.throws(
    () => buildChildEnv({ peerId: peer, env: {} }, { HOME: '/home/peer' }),
    (thrown: unknown) => {
      assert.equal((thrown as { code?: string }).code, 'invalid_input')
      return true
    },
  )
})

test('an unrecorded endpoint stays unrecorded', () => {
  const built = buildChildEnv({ peerId: peer, env: {} }, parent)
  assert.equal(recordedEndpoint(built.env), undefined)
  assert.equal(recordedModel(built.env), undefined)
})
