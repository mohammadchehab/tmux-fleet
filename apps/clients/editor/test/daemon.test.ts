/**
 * The one file in the extension that writes to a socket, against a real socket.
 *
 * It runs a fake `fleetd` on a temporary Unix socket: a line in, a line out. The
 * point is the framing and the contract check at both ends — that `ls` comes back
 * decoded, that a refusal arrives as the daemon's message rather than a stack
 * trace, and that a socket that is not there fails as a state the window can
 * draw.
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { DecisionId } from '@fleet/foundation-core'

import { daemonAt } from '../src/daemon.ts'
import { decisionOf, lsOf, peerOf } from './fixtures.ts'

/** A daemon that answers every line with `answer`, and records what it was asked. */
const fakeFleetd = async (
  answer: (request: { method: string; params: unknown }) => unknown,
): Promise<{ socketPath: string; requests: { method: string; params: unknown }[]; close: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-editor-daemon-'))
  const socketPath = join(dir, 'fleetd.sock')
  const requests: { method: string; params: unknown }[] = []

  const server: Server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(buffer.slice(0, newline)) as { method: string; params: unknown }
      requests.push(request)
      socket.write(`${JSON.stringify(answer(request))}\n`)
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve)
  })

  return {
    socketPath,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('ls comes back as the contract says, on one line', async () => {
  const listing = lsOf({ peers: [peerOf('engineer-1')] })
  const daemon = await fakeFleetd(() => ({ ok: true, result: listing }))
  try {
    const ls = await daemonAt(daemon.socketPath).ls()
    assert.equal(ls.status.profile, 'tmux-fleet')
    assert.equal(ls.peers[0]?.peerId, 'engineer-1')
    assert.deepEqual(daemon.requests, [{ id: 'ls', method: 'ls', params: {} }])
  } finally {
    await daemon.close()
  }
})

test('decide sends the id and the option, and nothing else', async () => {
  const answered = { ...decisionOf('dec_0123456789abcdef'), state: 'answered' as const, option: 'Yes' }
  const daemon = await fakeFleetd(() => ({ ok: true, result: answered }))
  try {
    await daemonAt(daemon.socketPath).decide({ id: 'dec_0123456789abcdef' as DecisionId, decision: 'Yes' })
    assert.deepEqual(daemon.requests, [
      { id: 'decide', method: 'decide', params: { id: 'dec_0123456789abcdef', decision: 'Yes' } },
    ])
  } finally {
    await daemon.close()
  }
})

test("a refusal is the daemon's own message, not an internal error", async () => {
  const daemon = await fakeFleetd(() => ({ ok: false, error: { code: 'invalid_input', message: 'no peer nobody' } }))
  try {
    await assert.rejects(async () => daemonAt(daemon.socketPath).ls(), /no peer nobody/)
  } finally {
    await daemon.close()
  }
})

test('an answer that is not the contract is refused here rather than rendered', async () => {
  const daemon = await fakeFleetd(() => ({ ok: true, result: { status: 'nonsense' } }))
  try {
    await assert.rejects(async () => daemonAt(daemon.socketPath).ls())
  } finally {
    await daemon.close()
  }
})

test('a socket with no daemon behind it rejects, naming the socket', async () => {
  const daemon = await fakeFleetd(() => ({ ok: true, result: lsOf() }))
  const socketPath = daemon.socketPath
  await daemon.close()
  await assert.rejects(async () => daemonAt(socketPath).ls(), /cannot reach fleetd at/)
})
