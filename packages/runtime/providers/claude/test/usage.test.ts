/**
 * `usage()` and the limit it reports against (§8). The limit is configured, not
 * measured: on a non-Anthropic endpoint the SDK has no window to report, and a
 * limit read off the same answer it is compared with cannot catch a wrong one.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { contextLimitFor, fallbackTokensFrom, usageFrom } from '../src/index.ts'

const limits = { byModel: { 'claude-opus-5-5': 200_000, 'deepseek-ai/DeepSeek-V4.1-Flash-1017': 1_048_576 }, fallback: 200_000 }

test('a configured window wins for the model that has one', () => {
  assert.equal(contextLimitFor(limits, 'claude-opus-5-5'), 200_000)
  assert.equal(contextLimitFor(limits, 'deepseek-ai/DeepSeek-V4.1-Flash-1017'), 1_048_576)
})

test('an unlisted model takes the fallback', () => {
  assert.equal(contextLimitFor(limits, 'something-new'), 200_000)
})

test('no limit configured at all is a configuration bug, not a guess', () => {
  assert.throws(
    () => contextLimitFor({ byModel: {}, fallback: 0 }, 'anything'),
    (thrown: unknown) => (thrown as { code?: string }).code === 'invalid_input',
  )
})

test('a measured token count is rounded and paired with the configured limit', () => {
  assert.deepEqual(usageFrom({ answer: { totalTokens: 10531.6 }, model: 'claude-opus-5-5', limits }), {
    contextTokens: 10532,
    contextLimit: 200_000,
  })
})

test('an empty or missing measurement falls back to the last result usage', () => {
  assert.deepEqual(
    usageFrom({ answer: { totalTokens: 0 }, fallbackTokens: 10_270, model: 'claude-opus-5-5', limits }),
    { contextTokens: 10_270, contextLimit: 200_000 },
  )
  assert.deepEqual(usageFrom({ answer: undefined, fallbackTokens: 9, model: 'claude-opus-5-5', limits }), {
    contextTokens: 9,
    contextLimit: 200_000,
  })
})

test('with no measurement at all the answer is "unmeasured", not "unlimited"', () => {
  assert.deepEqual(usageFrom({ answer: undefined, model: 'claude-opus-5-5', limits }), {
    contextTokens: 0,
    contextLimit: 200_000,
  })
})

test('cost travels only when the provider asked for it', () => {
  assert.equal(usageFrom({ answer: { totalTokens: 1 }, model: 'claude-opus-5-5', limits }).costUsd, undefined)
  assert.equal(
    usageFrom({ answer: { totalTokens: 1 }, model: 'claude-opus-5-5', limits, costUsd: 0.42 }).costUsd,
    0.42,
  )
})

test('the fallback reads the prompt side of a result, which every endpoint reports', () => {
  assert.equal(
    fallbackTokensFrom({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 }),
    105,
  )
  assert.equal(fallbackTokensFrom({ output_tokens: 40 }), undefined)
  assert.equal(fallbackTokensFrom(null), undefined)
})
