/**
 * A request that waits on something outlives its client unless the connection's
 * close reaches it: `peer.hold` waits for a turn, and a client killed in that
 * window must not leave the hold pending (watch-and-attach §4).
 */

import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { DaemonApi } from '@fleet/foundation-contracts'
import { createDaemonServer } from '../src/api/server.ts'

test('closing the connection aborts the signal a pending peer.hold and peer.stop were handed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-abort-'))
  const seen: Record<string, AbortSignal | undefined> = {}
  const waits = (method: 'hold' | 'stop') => (_params: unknown, signal?: AbortSignal) => {
    seen[method] = signal
    return new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
  }
  const api = { peerHold: waits('hold'), peerStop: waits('stop') } as unknown as DaemonApi
  const server = await createDaemonServer({ api, socketPath: join(home, 's.sock'), pidPath: join(home, 's.pid') })
  try {
    for (const method of ['peer.hold', 'peer.stop'] as const) {
      const socket = connect(join(home, 's.sock'))
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      socket.write(`${JSON.stringify({ id: '1', method, params: { peerId: 'engineer-1' } })}\n`)
      const key = method === 'peer.hold' ? 'hold' : 'stop'
      for (let i = 0; i < 100 && seen[key] === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      assert.ok(seen[key], `${method} was handed a signal`)
      assert.equal(seen[key]?.aborted as boolean, false, 'still connected: not aborted')
      socket.destroy()
      for (let i = 0; i < 100 && !(seen[key]?.aborted as boolean); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      assert.equal(seen[key]?.aborted as boolean, true, `${method}: the client went away, so the request is aborted`)
    }
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})
