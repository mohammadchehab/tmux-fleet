/**
 * The runner's own two facts: where a build's log goes, and what an exit code
 * means. Both are small, and both are things a caller reads back later (§11's
 * log is the only account of a build that ran on the remote host).
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildStdoutPath } from '@fleet/foundation-contracts'
import { buildLogPath, spawnToLog, statusOf } from '../src/runner.ts'
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

describe('spawnToLog', () => {
  it('keeps stdout whole in the log and alone in the answer file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-runner-'))
    const logPath = join(dir, 'build.log')
    const stdoutPath = buildStdoutPath(logPath)

    const outcome = await spawnToLog({
      file: process.execPath,
      args: ['-e', "process.stderr.write('narration\\n'); process.stdout.write('{\"answer\":1}\\n')"],
      logPath,
      stdoutPath,
    })

    assert.equal(outcome.code, 0)
    // The log is the whole build, in one file, for a person reading it.
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /narration/)
    assert.match(log, /\{"answer":1\}/)
    // The answer file is the same stdout with no narration in it: an eval run's
    // JSON is not something a reader should have to strip stderr out of (§17).
    assert.equal(await readFile(stdoutPath, 'utf8'), '{"answer":1}\n')
  })

  it('writes no answer file when none was asked for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-runner-'))
    const logPath = join(dir, 'build.log')
    await spawnToLog({ file: process.execPath, args: ['-e', "process.stdout.write('hi\\n')"], logPath })
    await assert.rejects(() => readFile(buildStdoutPath(logPath), 'utf8'), /ENOENT/)
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
