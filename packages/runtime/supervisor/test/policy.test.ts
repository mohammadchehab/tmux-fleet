/**
 * When a turn boundary ends a session (§8). The table is the policy, so it is
 * tested as one — including what it deliberately does *not* do.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkPurgeLimits, defaultPurgeLimits, purgeTrigger, type PurgeObservation } from '../src/index.ts'

const limits = { contextRatio: 0.8, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 }
const observation = (overrides: Partial<PurgeObservation> = {}): PurgeObservation => ({
  usage: { contextTokens: 0, contextLimit: 1_000 },
  usageTokens: true,
  turns: 0,
  sessionMillis: 0,
  limits,
  ...overrides,
})

test('a healthy session keeps working', () => {
  assert.equal(purgeTrigger(observation({ usage: { contextTokens: 100, contextLimit: 1_000 } })), undefined)
})

test('the trigger is a ratio of the configured limit, so the handoff still fits', () => {
  assert.equal(purgeTrigger(observation({ usage: { contextTokens: 799, contextLimit: 1_000 } })), undefined)
  assert.equal(purgeTrigger(observation({ usage: { contextTokens: 800, contextLimit: 1_000 } })), 'context')
  // The state-file turn runs *after* the trigger; waiting for 1.0 could not afford it.
  assert.ok(defaultPurgeLimits.contextRatio < 1)
})

test('the limit is whatever config said, not the provider’s guess (§4)', () => {
  // A 1M-window model reported as 200k would purge here at 160k; with the real
  // limit configured, the same tokens are barely a sixth of the way in.
  assert.equal(
    purgeTrigger(observation({ usage: { contextTokens: 160_000, contextLimit: 1_048_576 } })),
    undefined,
  )
})

test('a provider with no token usage purges on turns, then on the clock', () => {
  const noTokens = (turns: number, sessionMillis: number) =>
    purgeTrigger(observation({ usageTokens: false, turns, sessionMillis }))
  assert.equal(noTokens(9, 59_999), undefined)
  assert.equal(noTokens(10, 0), 'turns')
  assert.equal(noTokens(0, 60_000), 'wall_clock')
  // The provider's invented tokens are ignored entirely, not compared against.
  assert.equal(
    purgeTrigger(
      observation({ usageTokens: false, usage: { contextTokens: 5_000, contextLimit: 1_000 }, turns: 1 }),
    ),
    undefined,
  )
})

test('context wins over turns and clock, because it is the measured one', () => {
  assert.equal(
    purgeTrigger(
      observation({
        usage: { contextTokens: 900, contextLimit: 1_000 },
        turns: 50,
        sessionMillis: 10_000_000,
      }),
    ),
    'context',
  )
})

test('limits are checked at load, so a typo cannot silence the trigger', () => {
  assert.deepEqual(checkPurgeLimits(limits), limits)
  assert.ok(Object.isFrozen(checkPurgeLimits(limits)))
  for (const bad of [
    { ...limits, contextRatio: 0 },
    { ...limits, contextRatio: 1.5 },
    { ...limits, contextRatio: Number.NaN },
    { ...limits, maxTurns: 0 },
    { ...limits, maxTurns: 2.5 },
    { ...limits, maxSessionMillis: -1 },
  ]) {
    assert.throws(() => checkPurgeLimits(bad), (thrown: unknown) => (thrown as { code?: string }).code === 'invalid_input')
  }
})

/**
 * The purge that protects against a compaction is the one that reads the point
 * the *session* says it will compact at, not the window the profile configured.
 * The two can differ by a factor of five — a 1M-token model whose CLI compacts at
 * 200K — and a ratio against the window would never fire before the provider.
 */
test('the provider\'s own compaction point triggers first, below the configured window', () => {
  const usage = { contextTokens: 180_000, contextLimit: 1_000_000, autoCompactAt: 200_000 }
  assert.equal(purgeTrigger(observation({ usage })), 'auto_compact')
  // 90% of the compaction point, not of the window: 180K of 200K.
  assert.equal(purgeTrigger(observation({ usage: { ...usage, contextTokens: 179_999 } })), undefined)
})

test('a session the provider will not compact keeps the window ratio as its trigger', () => {
  const usage = { contextTokens: 850, contextLimit: 1_000 }
  assert.equal(purgeTrigger(observation({ usage })), 'context', 'no autoCompactAt means the window is all there is')
  assert.equal(purgeTrigger(observation({ usage: { ...usage, autoCompactAt: 0 } })), 'context', 'a bogus point is ignored')
})

test('the compaction point is only read when the provider reports tokens', () => {
  const usage = { contextTokens: 180_000, contextLimit: 1_000_000, autoCompactAt: 200_000 }
  assert.equal(
    purgeTrigger(observation({ usage, usageTokens: false, turns: 1, limits: { ...limits, maxTurns: 40 } })),
    undefined,
    'an agent with no usage numbers falls back to turns, not to a ratio it cannot measure',
  )
})

test('the auto-compact ratio is validated like every other limit', () => {
  assert.throws(() => checkPurgeLimits({ ...limits, autoCompactRatio: 0 }), /autoCompactRatio must be in \(0, 1\]/)
  assert.throws(() => checkPurgeLimits({ ...limits, autoCompactRatio: 1.5 }), /autoCompactRatio must be in \(0, 1\]/)
  assert.ok(defaultPurgeLimits.autoCompactRatio < 1, 'the handoff turn needs headroom under the compaction point')
})
