import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { FleetError, type PeerId } from '@fleet/foundation-core'
import type { LsResult } from '@fleet/foundation-contracts'
import { callDaemon, callerFor, isUnreachable } from '../src/client.ts'

const now = '2026-11-10T09:00:00.000Z'

const status = {
  profile: 'exit-test',
  pid: 4242,
  startedAt: now,
  socketPath: '/tmp/fleetd.sock',
  storePath: '/tmp/store.sqlite', protocolVersion: 2, purgeContextRatio: 0.6,
}

const peer = {
  peerId: 'engineer-1' as PeerId,
  role: 'engineer',
  providerId: 'claude',
  model: 'test-small',
  permissionMode: 'default' as const,
  briefVersion: 1,
  state: 'idle' as const,
  registeredAt: now,
  updatedAt: now,
}

const listing: LsResult = { status, peers: [peer], routines: [], decisions: [], compactions: [], tokens: [], activity: [] }

const message = {
  msgId: 'msg_0123456789abcdef',
  to: 'engineer-1',
  from: 'pm',
  kind: 'info',
  briefVersion: 1,
  body: 'have a look at the PR',
  state: 'acked',
  sentAt: now,
}

interface Reply {
  readonly line?: string
  /** Close the connection after answering, or instead of answering. */
  readonly close?: boolean
}

interface Served {
  readonly socketPath: string
  readonly requests: readonly { id?: string; method: string; params?: unknown }[]
  readonly close: () => Promise<void>
}

/** A one-shot daemon: each request is answered by `answer`, and every request is kept for inspection. */
const serve = async (answer: (request: { method: string; params?: unknown }) => Reply): Promise<Served> => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-cli-'))
  const socketPath = join(dir, 'fleetd.sock')
  const requests: { id?: string; method: string; params?: unknown }[] = []
  const sockets = new Set<Socket>()

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(buffer.slice(0, newline)) as { id?: string; method: string; params?: unknown }
      requests.push(request)
      const reply = answer(request)
      if (reply.line !== undefined) socket.write(reply.line)
      if (reply.close === true) socket.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))

  return {
    socketPath,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const ok = (result: unknown, id = 'ls'): Reply => ({ line: `${JSON.stringify({ id, ok: true, result })}\n` })

const failed = (code: string, text: string): Reply => ({
  line: `${JSON.stringify({ ok: false, error: { code, message: text } })}\n`,
})

const code = (error: unknown): string | undefined => (error instanceof FleetError ? error.code : undefined)

describe('callDaemon', () => {
  it('sends one line, and decodes the answer with the contract', async () => {
    const daemon = await serve(() => ok(listing))
    try {
      const result = await callDaemon({ socketPath: daemon.socketPath }, 'ls', {})
      assert.deepEqual(result, listing)
      assert.deepEqual(daemon.requests, [{ id: 'ls', method: 'ls', params: {} }])
    } finally {
      await daemon.close()
    }
  })

  it('drops a cancelled request, so the daemon drops the wait with it (TASK-116)', async () => {
    // A daemon that never answers a hold: only the cancel can end the call.
    const daemon = await serve(() => ({}))
    try {
      const controller = new AbortController()
      const pending = callDaemon({ socketPath: daemon.socketPath }, 'peer.hold', { peerId: 'a' as PeerId }, { signal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 30))
      controller.abort()

      await assert.rejects(pending, (error: unknown) => error instanceof FleetError && /cancelled/.test(error.message))
      assert.equal(daemon.requests.length, 1, 'the request reached the daemon before it was cancelled')
    } finally {
      await daemon.close()
    }
  })

  it('refuses to send a request whose signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(callDaemon({ socketPath: '/nonexistent/fleetd.sock' }, 'ls', {}, { signal: controller.signal }), (error: unknown) =>
      error instanceof FleetError && /cancelled/.test(error.message),
    )
  })

  it('checks the params before it opens a socket', async () => {
    // No daemon at this path at all: if the call reached the socket the error
    // would be `external_failed`, so `invalid_input` proves it never did.
    await assert.rejects(
      callDaemon({ socketPath: '/nonexistent/fleetd.sock' }, 'send', {
        to: 'not a peer' as PeerId,
        kind: 'info',
        body: 'hi',
      }),
      (error: unknown) => code(error) === 'invalid_input' && /send: .*to/.test((error as Error).message),
    )
  })

  it('turns a refusal into the daemon\'s own error code', async () => {
    const daemon = await serve(() => failed('not_found', 'no peer nobody'))
    try {
      await assert.rejects(
        callDaemon({ socketPath: daemon.socketPath }, 'peek', { peer: 'nobody' as PeerId }),
        (error: unknown) => code(error) === 'not_found' && (error as Error).message === 'no peer nobody',
      )
    } finally {
      await daemon.close()
    }
  })

  it('maps a code it does not know to `internal` rather than throwing on it', async () => {
    const daemon = await serve(() => failed('something_new', 'who knows'))
    try {
      await assert.rejects(callDaemon({ socketPath: daemon.socketPath }, 'ls', {}), (error: unknown) => code(error) === 'internal')
    } finally {
      await daemon.close()
    }
  })

  it('reports an answer that is not JSON as a broken daemon, not as a user error', async () => {
    const daemon = await serve(() => ({ line: 'fleetd says hello\n' }))
    try {
      await assert.rejects(
        callDaemon({ socketPath: daemon.socketPath }, 'ls', {}),
        (error: unknown) => code(error) === 'internal' && /not JSON/.test((error as Error).message),
      )
    } finally {
      await daemon.close()
    }
  })

  it('is unreachable when there is no daemon at the socket', async () => {
    const error = await callDaemon({ socketPath: '/nonexistent/fleetd.sock' }, 'ls', {}).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    assert.equal(code(error), 'external_failed', 'the one failure `fleet up` may answer by starting a daemon')
    assert.equal(isUnreachable(error), true)
    assert.match((error as Error).message, /cannot reach fleetd at/)
  })

  it('is unreachable when the daemon hangs up without answering', async () => {
    const daemon = await serve(() => ({ close: true }))
    try {
      const error = await callDaemon({ socketPath: daemon.socketPath }, 'ls', {}).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      assert.equal(code(error), 'external_failed')
      assert.equal(isUnreachable(error), true)
      assert.match((error as Error).message, /closed the connection without answering/)
    } finally {
      await daemon.close()
    }
  })

  it('is not unreachable when a live daemon answers with an external failure of its own', async () => {
    // A `gh` call that failed inside the daemon is `external_failed` too. The daemon answered, so
    // `fleet up` must not take it for "nobody is listening" and start a second one.
    const daemon = await serve(() => failed('external_failed', 'gh pr list failed'))
    try {
      const error = await callDaemon({ socketPath: daemon.socketPath }, 'ls', {}).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      assert.equal(code(error), 'external_failed', 'the daemon\'s own code is kept for the user')
      assert.match((error as Error).message, /gh pr list failed/)
      assert.equal(isUnreachable(error), false)
    } finally {
      await daemon.close()
    }
  })

  it('gives up on a daemon that accepts the connection and never answers', async () => {
    const daemon = await serve(() => ({}))
    try {
      await assert.rejects(
        callDaemon({ socketPath: daemon.socketPath, timeoutMs: 50 }, 'ls', {}),
        (error: unknown) => code(error) === 'timeout',
      )
    } finally {
      await daemon.close()
    }
  })
})

describe('callerFor', () => {
  it('binds every method to one socket', async () => {
    const daemon = await serve((request) => ok({ messages: [] }, request.method))
    try {
      const call = callerFor({ socketPath: daemon.socketPath })
      assert.deepEqual(await call('peek', { peer: 'engineer-1' as PeerId }), { messages: [] })
    } finally {
      await daemon.close()
    }
  })

  it('answers `send` with the id the Mailbox minted', async () => {
    const daemon = await serve(() => ok({ msgId: message.msgId }, 'send'))
    try {
      const call = callerFor({ socketPath: daemon.socketPath })
      assert.deepEqual(await call('send', { to: 'engineer-1' as PeerId, kind: 'info', body: 'hi' }), {
        msgId: message.msgId,
      })
    } finally {
      await daemon.close()
    }
  })
})
