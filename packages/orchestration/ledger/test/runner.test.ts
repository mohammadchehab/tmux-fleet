/**
 * The runner's own two facts: where a build's log goes, and what an exit code
 * means. Both are small, and both are things a caller reads back later (§11's
 * log is the only account of a build that ran on the remote host).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildLogPath, statusOf } from '../src/runner.ts'
import { sha } from './support/fakes.ts'

const SHA = sha()

describe('buildLogPath', () => {
  it('is one file per (sha, task), in the artifacts directory the profile names', () => {
    assert.equal(
      buildLogPath('/home/fleet/.fleet/dev/artifacts/builds', SHA, 'evals:judge:claude:opus'),
      `/home/fleet/.fleet/dev/artifacts/builds/${SHA}-evals-judge-claude-opus.log`,
    )
  })

  it('keeps a task readable and a path impossible', () => {
    // A task is a key, and a key that could contain `/` would let one build
    // write over another's log.
    const path = buildLogPath('/logs', SHA, 'test/../../etc/passwd')
    assert.equal(path, `/logs/${SHA}-test-..-..-etc-passwd.log`)
    assert.ok(!path.slice('/logs/'.length).includes('/'))
  })

  it('answers a path for a task that slugs to nothing', () => {
    assert.equal(buildLogPath('/logs', SHA, '///'), `/logs/${SHA}-x.log`)
  })
})

describe('statusOf', () => {
  it('is succeeded only for exit code 0', () => {
    assert.equal(statusOf(0), 'succeeded')
    assert.equal(statusOf(1), 'failed')
    assert.equal(statusOf(137), 'failed')
    // A process killed by a signal has no code, and that is not a success.
    assert.equal(statusOf(null), 'failed')
  })
})
