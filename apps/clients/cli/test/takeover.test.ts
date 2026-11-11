/** The real takeover against real child processes (watch-and-attach §5, §7). */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runTakeover } from '../src/takeover.ts'

const env = { PATH: process.env['PATH'] ?? '' }

/** A path the child creates once its signal handlers are installed: readiness, not a guess at how long that takes. */
const readyMarker = (): string => join(mkdtempSync(join(tmpdir(), 'fleet-takeover-')), 'ready')
const untilReady = async (marker: string): Promise<void> => {
  const deadline = Date.now() + 15_000
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('the child never became ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('it runs the command in the cwd it is given, with only the env it is given, and reports how it exited', async () => {
  const exit = await runTakeover(
    { executable: process.execPath, args: ['-e', "process.exit(process.cwd() === '/' && process.env.ONLY === 'this' && process.env.HOME === undefined ? 3 : 4)"] },
    { cwd: '/', env: { ...env, ONLY: 'this' } },
  )
  assert.deepEqual(exit, { code: 3, signal: null })
})

test('a child killed by a signal is an exit, not a failure', async () => {
  const exit = await runTakeover({ executable: process.execPath, args: ['-e', "process.kill(process.pid, 'SIGKILL')"] }, { cwd: '/', env })
  assert.deepEqual(exit, { code: null, signal: 'SIGKILL' })
})

test('a SIGINT while the child runs does not kill this process, and the handler is gone afterwards', async () => {
  const before = process.listenerCount('SIGINT')
  // The child sends this process the SIGINT a ctrl-c would, then exits. Without the
  // takeover's ignore handler the default action would end the test runner here.
  const exit = await runTakeover(
    { executable: process.execPath, args: ['-e', "process.kill(process.ppid, 'SIGINT'); setTimeout(() => process.exit(0), 50)"] },
    { cwd: '/', env },
  )
  assert.deepEqual(exit, { code: 0, signal: null })
  assert.equal(process.listenerCount('SIGINT'), before)
})

test('a command that does not exist rejects, and leaves no SIGINT handler behind', async () => {
  const before = process.listenerCount('SIGINT')
  await assert.rejects(runTakeover({ executable: '/no/such/cli', args: [] }, { cwd: '/', env }), /ENOENT/)
  assert.equal(process.listenerCount('SIGINT'), before)
})

test('a SIGHUP or SIGTERM to this process is forwarded to the child and waited out, so the release can follow', async () => {
  for (const signal of ['SIGHUP', 'SIGTERM'] as const) {
    const before = process.listenerCount(signal)
    const marker = readyMarker()
    const running = runTakeover(
      {
        executable: process.execPath,
        args: ['-e', "process.on('SIGHUP', () => process.exit(7)); process.on('SIGTERM', () => process.exit(8)); require('fs').writeFileSync(process.env.READY, '1'); setInterval(() => undefined, 1000)"],
      },
      { cwd: '/', env: { ...env, READY: marker } },
    )
    await untilReady(marker)
    process.kill(process.pid, signal)
    const exit = await running
    assert.deepEqual(exit, { code: signal === 'SIGHUP' ? 7 : 8, signal: null })
    assert.equal(process.listenerCount(signal), before)
  }
})

test('a child that ignores the hangup is escalated, so it cannot keep a peer held', async () => {
  const marker = readyMarker()
  const running = runTakeover(
    {
      executable: process.execPath,
      args: ['-e', "process.on('SIGHUP', () => undefined); process.on('SIGTERM', () => undefined); require('fs').writeFileSync(process.env.READY, '1'); setInterval(() => undefined, 1000)"],
    },
    { cwd: '/', env: { ...env, READY: marker }, graceMs: 200 },
  )
  await untilReady(marker)
  process.kill(process.pid, 'SIGHUP')
  const exit = await running
  assert.equal(exit.signal, 'SIGKILL')
})
