/**
 * §11's key space, as tests: a task's class is what routes, and the eval task
 * that §17 names is spelled so it fits §11's `(repo, sha, task)` key.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildTaskClass, evalBuildTask, EVAL_TASK_CLASS } from '../src/task.ts'

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

describe('evalBuildTask', () => {
  it('encodes §17 five-tuple into §11 three-tuple', () => {
    assert.equal(
      evalBuildTask({ suite: 'judge', provider: 'claude', model: 'opus' }),
      'evals:judge:claude:opus',
    )
  })

  it('admits the task under the class the ledger routes on', () => {
    const task = evalBuildTask({ suite: 'judge', provider: 'deepinfra', model: 'qwen3' })
    assert.equal(buildTaskClass(task), EVAL_TASK_CLASS)
  })

  it('refuses an empty part, naming it', () => {
    assert.throws(
      () => evalBuildTask({ suite: '', provider: 'claude', model: 'opus' }),
      (error: Error & { code?: string }) => error.code === 'invalid_input' && error.message.includes('suite'),
    )
    // The model is a part too: a run that cannot say which model it ran is not
    // a run §17 could compare against a baseline.
    assert.throws(
      () => evalBuildTask({ suite: 'judge', provider: 'claude', model: '' }),
      (error: Error & { code?: string }) => error.code === 'invalid_input' && error.message.includes('model'),
    )
  })

  it('refuses a part containing the separator, because the key would be ambiguous', () => {
    assert.throws(
      () => evalBuildTask({ suite: 'judge', provider: 'claude', model: 'vendor:model' }),
      (error: Error & { code?: string }) =>
        error.code === 'invalid_input' && error.message.includes('separates'),
    )
  })
})
