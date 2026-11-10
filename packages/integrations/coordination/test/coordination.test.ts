import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCoordination } from '../src/index.ts'

test('coordination port exists', () => {
  const coordination = createCoordination()
  assert.ok(coordination)
  assert.strictEqual(typeof coordination.listRefs, 'function')
  assert.strictEqual(typeof coordination.fetch, 'function')
  assert.strictEqual(typeof coordination.push, 'function')
  assert.strictEqual(typeof coordination.createRef, 'function')
  assert.strictEqual(typeof coordination.deleteRef, 'function')
})
