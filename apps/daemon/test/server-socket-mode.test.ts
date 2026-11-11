/**
 * The daemon socket is its owner's alone (watch-and-attach §4): `peer.hold`
 * hands a takeover the env the headless session got, and that can carry a
 * provider key. Another user on the host must not be able to connect.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { DaemonApi } from '@fleet/foundation-contracts'
import { createDaemonServer } from '../src/api/server.ts'

test('the socket is created 0600 and its new directory 0700, whatever the umask', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-mode-'))
  const socketPath = join(home, 'run', 'fleetd.sock')
  const before = process.umask(0o000)
  try {
    const server = await createDaemonServer({ api: {} as DaemonApi, socketPath, pidPath: join(home, 'fleetd.pid') })
    try {
      assert.equal((await stat(socketPath)).mode & 0o777, 0o600)
      assert.equal((await stat(join(home, 'run'))).mode & 0o777, 0o700)
      assert.equal(process.umask(), 0o000, 'the process umask is put back after listen')
    } finally {
      await server.close()
    }
  } finally {
    process.umask(before)
    await rm(home, { recursive: true, force: true })
  }
})
