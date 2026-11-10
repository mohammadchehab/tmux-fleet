import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectSnapshot } from '../src/index.ts'

test('collectSnapshot builds pace and capacity', () => {
  const capacity = new Map([
    ['architect', 2],
    ['engineer', 1],
  ])

  const snapshot = collectSnapshot({
    monthlyCap: 100,
    spent: 50,
    elapsedPercent: 50,
    capacity,
  })

  assert.strictEqual(snapshot.budget.cap, 100)
  assert.strictEqual(snapshot.budget.spent, 50)
  assert.strictEqual(snapshot.budget.pace, 1.0)
  assert.strictEqual(snapshot.capacity.length, 2)
  assert.ok(snapshot.heartbeat)
})

test('collectSnapshot handles under-pace', () => {
  const snapshot = collectSnapshot({
    monthlyCap: 100,
    spent: 25,
    elapsedPercent: 50,
    capacity: new Map(),
  })

  assert.strictEqual(snapshot.budget.pace, 0.5)
})

test('collectSnapshot handles over-pace', () => {
  const snapshot = collectSnapshot({
    monthlyCap: 100,
    spent: 75,
    elapsedPercent: 50,
    capacity: new Map(),
  })

  assert.strictEqual(snapshot.budget.pace, 1.5)
})
