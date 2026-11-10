/**
 * `usage()` and the limit it reports against (§8). The limit is configured, not
 * measured: on a non-Anthropic endpoint the SDK has no window to report, and a
 * limit read off the same answer it is compared with cannot catch a wrong one.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { contextLimitFor, fallbackTokensFrom, noSpend, spendFrom, usageFrom } from '../src/index.ts'

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

// ------------------------------------------------------------------ turn spend

/** A `result` message as the SDK writes it, with only the fields `spendFrom` reads. */
const result = (modelUsage: Record<string, Record<string, number>>): unknown => ({
  type: 'result',
  subtype: 'success',
  modelUsage,
})

test('a turn is the difference between two boundary messages, subagents included', () => {
  // Subagents are the reason this reads `modelUsage`: the main loop's own
  // counters cannot see a Task that spent 40k tokens inside the turn (§6.2).
  const before = result({ 'claude-sonnet-5-5': { inputTokens: 1_000, outputTokens: 200, cacheReadInputTokens: 9_000, costUSD: 0.1 } })
  const after = result({
    'claude-sonnet-5-5': { inputTokens: 1_800, outputTokens: 500, cacheReadInputTokens: 30_000, costUSD: 0.31 },
    'claude-haiku-4-5': { inputTokens: 40_000, outputTokens: 900, cacheReadInputTokens: 0, costUSD: 0.02 },
  })

  const first = spendFrom(before, noSpend)
  assert.deepEqual(first.spend, { inputTokens: 1_000, outputTokens: 200, cachedTokens: 9_000, costUsd: 0.1 })

  const second = spendFrom(after, first.totals)
  assert.deepEqual(second.spend, { inputTokens: 40_800, outputTokens: 1_200, cachedTokens: 21_000, costUsd: 0.23 })
})

test('a counter that went backwards rebases instead of underflowing', () => {
  const seen = { inputTokens: 10_000, outputTokens: 2_000, cachedTokens: 30_000, costUsd: 0.9 }
  // `/clear` resets the running total; the turn spent what the message now
  // says, and reporting `-8_000` would be a number no report can use.
  const measured = spendFrom(result({ 'claude-sonnet-5-5': { inputTokens: 2_000, outputTokens: 300, cacheReadInputTokens: 0, costUSD: 0.05 } }), seen)
  assert.equal(measured.spend?.inputTokens, 0)
  assert.equal(measured.spend?.outputTokens, 0)
  assert.equal(measured.spend?.costUsd, undefined, 'a cost that reset is not a negative cost either')
  assert.deepEqual(measured.totals, { inputTokens: 2_000, outputTokens: 300, cachedTokens: 0, costUsd: 0.05 })
})

test('a result with no modelUsage falls back to the main loop, and one with neither reports nothing', () => {
  const mainLoop = spendFrom(
    { type: 'result', subtype: 'success', usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 400 } },
    noSpend,
  )
  assert.deepEqual(mainLoop.spend, { inputTokens: 12, outputTokens: 3, cachedTokens: 400 })

  const zeroed = spendFrom({ type: 'result', subtype: 'error_during_execution', usage: {} }, noSpend)
  assert.equal(zeroed.spend, undefined, 'a startup error measured nothing; a zeroed row would read as a free turn')
  assert.deepEqual(zeroed.totals, noSpend)
})
