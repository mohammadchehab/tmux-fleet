/**
 * Verify that server.close() completes even when an idle client
 * holds the connection open, so shutdown cleanup code can run.
 */

import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'
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

    let server: DaemonServer | undefined
    let socket: any

    try {
      // Minimal mock API: the test doesn't invoke any methods, just tests socket lifecycle
      const api = {
        up: async () => ({ ok: true }),
        down: async () => ({ ok: true, result: { stopped: true } }),
      } as unknown as DaemonApi

      server = await createDaemonServer({
        api,
        socketPath,
        pidPath,
        onDown: () => {
          // onDown hook - test doesn't check this, just verifies it's callable
        },
      })

      // Open a socket connection but keep it idle (never send data)
      socket = connect(socketPath)
      await new Promise<void>((resolve) => {
        socket.on('connect', resolve)
      })

      // Measure how long server.close() takes with idle client
      const startClose = Date.now()

      // Set a timeout to detect if close() hangs forever
      const timeoutMs = 5000 // 5 seconds is reasonable for cleanup
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`server.close() timed out after ${timeoutMs}ms`)), timeoutMs)
      )

      await Promise.race([server.close(), timeoutPromise])
      const closeTime = Date.now() - startClose

      // close() should complete quickly despite the idle client
      assert.ok(closeTime < 1000, `server.close() took ${closeTime}ms, expected < 1000ms`)
    } finally {
      // Ensure socket is destroyed
      if (socket) socket.destroy()
      // Ensure server is fully closed
      if (server) await server.close().catch(() => {})
      // Clean up temp directory
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not cut off in-flight RPC responses like down', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fleet-server-'))
    const socketPath = join(home, 'test.sock')
    const pidPath = join(home, 'test.pid')

    let server: DaemonServer | undefined
    let responseSocket: Socket | undefined

    try {
      const api = {
        up: async () => ({ ok: true }),
        down: async () => ({ ok: true, result: { stopped: true } }),
      } as unknown as DaemonApi

      server = await createDaemonServer({
        api,
        socketPath,
        pidPath,
      })

      // Send a down RPC request and immediately close the server
      const responsePromise = (async () => {
        const client = connect(socketPath)
        responseSocket = client
        return new Promise<string>((resolve, reject) => {
          client.setEncoding('utf8')
          let buffer = ''
          client.on('data', (chunk: string) => {
            buffer += chunk
            const newline = buffer.indexOf('\n')
            if (newline !== -1) {
              resolve(buffer.slice(0, newline))
              client.destroy()
            }
          })
          client.on('error', reject)
          client.write('{"id":"down-1","method":"down"}\n')
        })
      })()

      // Close the server after a short delay (but before timeout)
      // The down response should still arrive because it's active
      await new Promise((resolve) => setTimeout(resolve, 10))
      const closePromise = server.close()

      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('down response timed out')), 2000)
        ),
      ])

      // Verify we got a valid down response despite server.close() being called
      const parsed = JSON.parse(response)
      assert.equal((parsed as any).ok, true)
      assert.ok((parsed as any).result)

      // Ensure close promise completes
      await closePromise
    } finally {
      // Ensure sockets are destroyed
      if (responseSocket) responseSocket.destroy()
      // Ensure server is fully closed
      if (server) await server.close().catch(() => {})
      // Clean up temp directory
      await rm(home, { recursive: true, force: true })
    }
  })
})
