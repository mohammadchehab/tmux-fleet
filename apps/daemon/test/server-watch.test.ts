/** `peer.watch` over the real socket: frames with the request id, one connection per watch, and a stalled client dropped (watch-and-attach §6). */

import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { PeerId } from '@fleet/foundation-core'
import { daemonProtocolVersion, type DaemonApi, type WatchFrame } from '@fleet/foundation-contracts'

import { createDisplayFeed } from '../src/execution/display.ts'
import { createDaemonServer } from '../src/api/server.ts'

const a = 'engineer-1' as PeerId

const rig = async (extra: Partial<Parameters<typeof createDaemonServer>[0]> = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-watch-'))
  const feed = createDisplayFeed({ flushMs: 5 })
  const api = { ls: async () => ({ ok: 'ls' }) } as unknown as DaemonApi
  const socketPath = join(home, 's.sock')
  const server = await createDaemonServer({ api, socketPath, pidPath: join(home, 's.pid'), watch: (params) => feed.watch(params), ...extra })
  const clients: Socket[] = []
  const open = async (): Promise<Socket> => {
    const socket = connect(socketPath)
    clients.push(socket)
    socket.setEncoding('utf8')
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    return socket
  }
  const done = async (): Promise<void> => {
    for (const socket of clients) socket.destroy()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
  return { feed, open, done }
}

/** Read newline-delimited JSON off a socket as it arrives. */
const lines = (socket: Socket) => {
  const out: Record<string, unknown>[] = []
  let buffer = ''
  let wake: (() => void) | undefined
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) if (part !== '') out.push(JSON.parse(part) as Record<string, unknown>)
    wake?.()
  })
  socket.on('close', () => wake?.())
  return {
    out,
    until: async (predicate: () => boolean, ms = 2_000): Promise<void> => {
      const deadline = Date.now() + ms
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out; saw ${JSON.stringify(out.slice(-3))}`)
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, 20)
        })
      }
    },
  }
}

test('a watch replays the buffer under the request id, says ready, then streams what the feed gets, and ends when asked', async () => {
  const { feed, open, done } = await rig()
  try {
    feed.push(a, { kind: 'tool', tool: 'Bash', summary: 'ls' })
    const socket = await open()
    const read = lines(socket)
    socket.write(`${JSON.stringify({ id: 'w1', method: 'peer.watch', params: {} })}\n`)
    await read.until(() => read.out.some((frame) => frame['stream'] === 'ready'))
    assert.deepEqual(read.out.map((frame) => [frame['id'], frame['stream']]), [['w1', 'line'], ['w1', 'ready']])
    assert.equal(read.out[1]?.['protocolVersion'], daemonProtocolVersion)

    feed.push(a, { kind: 'turn', phase: 'started' })
    feed.row({ kind: 'state', peerId: a, state: 'working' })
    await read.until(() => read.out.length === 4)
    assert.deepEqual(read.out.slice(2).map((frame) => frame['stream']), ['line', 'row'])
    const row = read.out[3] as unknown as Extract<WatchFrame, { stream: 'row' }>
    assert.deepEqual(row.row, { kind: 'state', peerId: a, state: 'working' })

    feed.closeAll('shutdown')
    await read.until(() => read.out.some((frame) => frame['stream'] === 'end'))
    assert.equal(read.out.at(-1)?.['reason'], 'shutdown')
    await new Promise<void>((resolve) => socket.once('close', resolve)) // and the daemon closes the connection
  } finally {
    await done()
  }
})

test('bad watch params are answered as any request is, with one error line, and open no stream', async () => {
  const { open, done } = await rig()
  try {
    const socket = await open()
    const read = lines(socket)
    socket.write(`${JSON.stringify({ id: 'w2', method: 'peer.watch', params: { since: -4 } })}\n`)
    await read.until(() => read.out.length === 1)
    assert.equal(read.out[0]?.['ok'], false)
    assert.equal(read.out[0]?.['id'], 'w2')
    assert.equal((read.out[0]?.['error'] as { code: string }).code, 'invalid_input')
    // Not a watch after all: the same connection still takes an ordinary request.
    socket.write(`${JSON.stringify({ id: 'r1', method: 'ls' })}\n`)
    await read.until(() => read.out.length === 2)
    assert.equal(read.out[1]?.['ok'], true)
  } finally {
    await done()
  }
})

test('a connection that is a watch refuses a second request, so a stream never blocks a queue behind it', async () => {
  const { open, done } = await rig()
  try {
    const socket = await open()
    const read = lines(socket)
    socket.write(`${JSON.stringify({ id: 'w3', method: 'peer.watch', params: {} })}\n`)
    await read.until(() => read.out.some((frame) => frame['stream'] === 'ready'))
    socket.write(`${JSON.stringify({ id: 'r2', method: 'ls' })}\n`)
    await read.until(() => read.out.some((frame) => frame['ok'] === false))
    assert.equal((read.out.find((frame) => frame['ok'] === false)?.['error'] as { code: string }).code, 'invalid_input')
  } finally {
    await done()
  }
})

test('a daemon with no feed refuses peer.watch as unsupported instead of hanging', async () => {
  const { open, done } = await rig({ watch: undefined })
  try {
    const socket = await open()
    const read = lines(socket)
    socket.write(`${JSON.stringify({ id: 'w4', method: 'peer.watch' })}\n`)
    await read.until(() => read.out.length === 1)
    assert.equal((read.out[0]?.['error'] as { code: string }).code, 'unsupported')
  } finally {
    await done()
  }
})

test('a client that closes ends its stream, and the feed forgets it', async () => {
  let returned = 0
  const { open, done } = await rig({
    watch: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<WatchFrame>>(() => undefined), // never yields: a quiet fleet
        return: async () => {
          returned += 1
          return { value: undefined, done: true }
        },
      }),
    }),
  })
  try {
    const socket = await open()
    socket.write(`${JSON.stringify({ id: 'w5', method: 'peer.watch' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    socket.destroy()
    for (let i = 0; i < 100 && returned === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(returned >= 1, 'the stream was told to stop')
  } finally {
    await done()
  }
})

test('a stalled client is dropped, the feed keeps taking lines, and the peer side is never waited for', async () => {
  // The client's own socket stays paused, so it never sees the close: the drop is observed
  // from the daemon's side, as the stream being told to stop.
  let stopped = false
  const feed = createDisplayFeed({ flushMs: 5 })
  const { open, done } = await rig({
    watchBufferCap: 64 * 1024,
    watch: (params) => ({
      [Symbol.asyncIterator]: () => {
        const inner = feed.watch(params)[Symbol.asyncIterator]()
        return {
          next: () => inner.next(),
          return: async () => {
            stopped = true
            return inner.return?.() ?? { value: undefined, done: true }
          },
        }
      },
    }),
  })
  try {
    const socket = await open()
    socket.pause() // a client that connected and stopped reading
    socket.write(`${JSON.stringify({ id: 'w6', method: 'peer.watch' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const started = Date.now()
    const big = 'z'.repeat(390)
    for (let i = 0; i < 20_000; i += 1) {
      feed.push(a, { kind: 'text', text: `${big}\n` })
      if (i % 500 === 0) await new Promise((resolve) => setImmediate(resolve)) // let the socket write
    }
    assert.ok(Date.now() - started < 5_000, 'pushing never waited for the stalled client')
    assert.equal(feed.seq, 20_000, 'every line was taken by the feed')
    for (let i = 0; i < 200 && !stopped; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(stopped, 'the stalled client was dropped')
  } finally {
    await done()
  }
})
