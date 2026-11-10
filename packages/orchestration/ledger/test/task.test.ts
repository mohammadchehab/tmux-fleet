/**
 * §11's key space, as the ledger reads it: a task's class is what routes. The
 * encodings a caller and the ledger share are tested in
 * `foundation/contracts`, which is where both may reach them.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildTaskClass } from '../src/task.ts'

describe('buildTaskClass', () => {
  it('is the text before the first colon', () => {
    assert.equal(buildTaskClass('test'), 'test')
    assert.equal(buildTaskClass('test:unit'), 'test')
    assert.equal(buildTaskClass('evals:judge:claude:opus'), 'evals')
  })

  it('keeps a task with no colon whole, and an empty class empty', () => {
    assert.equal(buildTaskClass('lint --fix'), 'lint --fix')
    // The odd shape is answered, not repaired: `:detail` has no class, and a
    // routing table that matched it to the whole string would be a lie.
    assert.equal(buildTaskClass(':detail'), '')
  })
})
