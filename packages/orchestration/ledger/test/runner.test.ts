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
import { repo, sha } from './support/fakes.ts'

const SHA = sha()

describe('buildLogPath keys a file to the whole build (TASK-97)', () => {
  const other = repo('acme/gadgets')

  it('does not give two different tasks one file when their slugs agree', () => {
    const a = buildLogPath('/logs', SHA, 'evals:judge:a-b:c', repo())
    const b = buildLogPath('/logs', SHA, 'evals:judge:a:b-c', repo())
    assert.notEqual(a, b)
    assert.equal(a, buildLogPath('/logs', SHA, 'evals:judge:a-b:c', repo()), 'and one build keeps one name')
  })

  it('does not give two repos one file for the same sha and task', () => {
    assert.notEqual(buildLogPath('/logs', SHA, 'test', repo()), buildLogPath('/logs', SHA, 'test', other))
  })
})

describe('buildLogPath', () => {
  it('is one file per (repo, sha, task), in the artifacts directory the profile names', () => {
    assert.match(
      buildLogPath('/home/fleet/.fleet/dev/artifacts/builds', SHA, 'evals:judge:claude:opus', repo()),
      new RegExp(`^/home/fleet/\\.fleet/dev/artifacts/builds/${SHA}-evals-judge-claude-opus-[0-9a-f]{8}\\.log$`),
    )
  })

  it('keeps a task readable and a path impossible', () => {
    // A task is a key, and a key that could contain `/` would let one build
    // write over another's log.
    const path = buildLogPath('/logs', SHA, 'test/../../etc/passwd', repo())
    assert.ok(path.startsWith(`/logs/${SHA}-test-..-..-etc-passwd-`))
    assert.ok(!path.slice('/logs/'.length).includes('/'))
  })

  it('answers a path for a task that slugs to nothing', () => {
    assert.match(buildLogPath('/logs', SHA, '///', repo()), new RegExp(`^/logs/${SHA}-x-[0-9a-f]{8}\\.log$`))
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

  it('starts each run from empty files, so a rerun of a build does not append to the first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-runner-'))
    const logPath = join(dir, 'build.log')
    const stdoutPath = buildStdoutPath(logPath)
    const say = (text: string) => ({
      file: process.execPath,
      args: ['-e', `process.stderr.write('narration ${text}\\n'); process.stdout.write('{"run":"${text}"}\\n')`],
      logPath,
      stdoutPath,
    })

    await spawnToLog(say('first'))
    await spawnToLog(say('second'))

    assert.equal(await readFile(stdoutPath, 'utf8'), '{"run":"second"}\n', 'the answer is the last run’s alone')
    assert.doesNotMatch(await readFile(logPath, 'utf8'), /first/)
  })

  it('writes no answer file when none was asked for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-runner-'))
    const logPath = join(dir, 'build.log')
    await spawnToLog({ file: process.execPath, args: ['-e', "process.stdout.write('hi\\n')"], logPath })
    await assert.rejects(() => readFile(buildStdoutPath(logPath), 'utf8'), /ENOENT/)
  })

  it('times out and kills a hung process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-runner-'))
    const logPath = join(dir, 'build.log')

    // The timer starts at spawn, so no load can make the child finish first: the assertions are on the kill, not on
    // how long it took. The margin is the only wall-clock number, and it is only a bound for a hang (TASK-110).
    const promise = spawnToLog({
      file: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      logPath,
      timeoutMs: 100,
    })

    await assert.rejects(promise, /timeout/)
    // The kill is in the log, and the log holds it by the time the caller hears of the timeout: a reader who reads the
    // log right after the rejection must see why the build ended.
    assert.match(await readFile(logPath, 'utf8'), /timed out after 100ms and was killed/)
  })

  it('resolves only once the log holds every byte the build wrote, so a reader after the outcome sees all of it (TASK-110)', async () => {
    // A large write is what makes the race visible: the child exits while the log is still draining, and the outcome used
    // to arrive before the file did. Under load a small write loses the same race; a large one loses it every time.
    const dir = await mkdtemp(join(tmpdir(), 'fleet-runner-'))
    const logPath = join(dir, 'build.log')
    const stdoutPath = buildStdoutPath(logPath)
    const bytes = 16 << 20

    const outcome = await spawnToLog({
      file: process.execPath,
      args: ['-e', `process.stdout.write('x'.repeat(${bytes}))`],
      logPath,
      stdoutPath,
    })

    assert.equal(outcome.code, 0)
    assert.equal((await readFile(logPath)).length, bytes, 'the whole log, as soon as the outcome is known')
    assert.equal((await readFile(stdoutPath)).length, bytes, 'and the whole answer file')
  })

  it('rejects with stream write errors instead of throwing uncaught exceptions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-runner-'))
    // Use a path that will fail with EACCES by pointing to a directory
    const logPath = join(dir, 'subdir')
    // Create the directory so opening it as a file will fail
    await import('node:fs/promises').then((fs) => fs.mkdir(logPath))

    const promise = spawnToLog({
      file: process.execPath,
      args: ['-e', "process.stdout.write('test\\n')"],
      logPath,
    })

    // Should reject, not throw an uncaught exception
    await assert.rejects(promise)
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
