/**
 * Verify that server.close() completes even when an idle client
 * holds the connection open, so shutdown cleanup code can run.
 */

import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { DaemonApi } from '@fleet/foundation-contracts'
import { createDaemonServer, type DaemonServer } from '../src/api/server.ts'

describe('server.close() with idle clients', () => {
  it('completes within reasonable time even when an idle client holds the connection open', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fleet-server-'))
    const socketPath = join(home, 'test.sock')
    const pidPath = join(home, 'test.pid')
    let onDownCalled = false

    try {
      // Minimal mock API: the test doesn't invoke any methods, just tests socket lifecycle
      const api = {
        up: async () => ({ ok: true }),
        down: async () => ({ ok: true, result: { stopped: true } }),
      } as unknown as DaemonApi

      const server = await createDaemonServer({
        api,
        socketPath,
        pidPath,
        onDown: () => {
          onDownCalled = true
        },
      })

      // Open a socket connection but keep it idle (never close it)
      const socket = connect(socketPath)
      await new Promise<void>((resolve) => {
        socket.on('connect', resolve)
      })

      // Measure how long server.close() takes
      const startClose = Date.now()
      const closePromise = server.close()

      // Set a timeout to detect if close() hangs forever
      const timeoutMs = 5000 // 5 seconds is reasonable for cleanup
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`server.close() timed out after ${timeoutMs}ms`)), timeoutMs)
      )

      await Promise.race([closePromise, timeoutPromise])
      const closeTime = Date.now() - startClose

      // close() should complete quickly despite the idle client
      assert.ok(closeTime < 1000, `server.close() took ${closeTime}ms, expected < 1000ms`)

      // Cleanup should be able to proceed (onDown would have been called by the daemon layer)
      socket.destroy()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
