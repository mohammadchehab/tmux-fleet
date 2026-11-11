/** The real takeover against real child processes (watch-and-attach §5, §7). */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runTakeover } from '../src/takeover.ts'

const env = { PATH: process.env['PATH'] ?? '' }

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
