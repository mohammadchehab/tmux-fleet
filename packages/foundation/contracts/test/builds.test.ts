/**
 * The two spellings a caller and the ledger share: §17's eval run as §11's task,
 * and where the ledger keeps a build's answer. Both are strings two processes have to
 * agree on, which is the only reason they are in `foundation` at all.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildStdoutPath, evalBuildTask, EVAL_TASK_CLASS } from '../src/builds.ts'

/** Everything before the first `:` — the class the ledger routes on (§11). */
const taskClass = (task: string): string => {
  const at = task.indexOf(':')
  return at === -1 ? task : task.slice(0, at)
}

describe('evalBuildTask', () => {
  it('encodes §17 five-tuple into §11 three-tuple', () => {
    assert.equal(
      evalBuildTask({ suite: 'judge', provider: 'claude', model: 'opus' }),
      'evals:judge:claude:opus',
    )
  })

  it('files a baseline run apart from a plain one, under the same class (TASK-35)', () => {
    const identity = { suite: 'judge', provider: 'claude', model: 'opus' }
    const plain = evalBuildTask(identity)
    const baseline = evalBuildTask({ ...identity, saveBaseline: true })
    assert.notEqual(baseline, plain)
    assert.equal(evalBuildTask({ ...identity, saveBaseline: false }), plain, 'false is the plain run')
    assert.equal(taskClass(baseline), EVAL_TASK_CLASS)
  })

  it('admits the task under the class the ledger routes on', () => {
    const task = evalBuildTask({ suite: 'judge', provider: 'deepinfra', model: 'qwen3' })
    assert.equal(taskClass(task), EVAL_TASK_CLASS)
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

  it('keeps a model id that has a colon in it, such as an ollama tag (TASK-77)', () => {
    const task = evalBuildTask({ suite: 'judge', provider: 'ollama', model: 'llama3:8b' })
    assert.equal(task, 'evals:judge:ollama:llama3%3A8b')
    assert.equal(taskClass(task), EVAL_TASK_CLASS, 'a colon in a part never moves the class boundary')
    assert.equal(task.split(':').length, 4, 'and never adds a separator')
  })

  it('does not let a part pose as the baseline suffix or as another part', () => {
    const plain = { suite: 'judge', provider: 'claude' }
    // The #194 gap: `x:baseline` as a model must not be the key of a baseline run of `x`.
    assert.notEqual(
      evalBuildTask({ ...plain, model: 'x:baseline' }),
      evalBuildTask({ ...plain, model: 'x', saveBaseline: true }),
    )
    // Nor may a colon move a boundary between two parts.
    assert.notEqual(
      evalBuildTask({ suite: 'a:b', provider: 'c', model: 'm' }),
      evalBuildTask({ suite: 'a', provider: 'b:c', model: 'm' }),
    )
  })

  it('is injective: a literal percent sign is not another part’s escape', () => {
    const base = { suite: 'judge', provider: 'claude' }
    assert.notEqual(evalBuildTask({ ...base, model: 'a%3Ab' }), evalBuildTask({ ...base, model: 'a:b' }))
    assert.equal(evalBuildTask({ ...base, model: 'a%b' }), 'evals:judge:claude:a%25b')
  })

  it('leaves a name with neither character exactly as it was, so keys already in the log still match', () => {
    assert.equal(evalBuildTask({ suite: 'judge', provider: 'deepinfra', model: 'Qwen/Qwen3-235B.v2_x' }), 'evals:judge:deepinfra:Qwen/Qwen3-235B.v2_x')
  })
})

describe('buildStdoutPath', () => {
  it('is the log path with the answer extension, beside the log', () => {
    assert.equal(buildStdoutPath('/logs/sha-test.log'), '/logs/sha-test.out')
    // The same build, the same name: only the extension separates the whole log
    // from its answer.
    assert.equal(
      buildStdoutPath('/artifacts/builds/sha-evals-judge-claude-opus.log'),
      '/artifacts/builds/sha-evals-judge-claude-opus.out',
    )
  })

  it('adds an extension to a path that does not end in one', () => {
    assert.equal(buildStdoutPath('/logs/somewhere'), '/logs/somewhere.out')
  })
})
