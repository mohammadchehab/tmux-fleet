/**
 * The wire, against a real socket: a fake daemon in a temp directory speaks one
 * JSON line and the view decodes it with the contract's own schemas.
 *
 * This is the half a pure test cannot prove. The renderers are asserted from an
 * `LsResult` object; here that object arrives as bytes, is checked by
 * `daemonResultFor('ls')`, and comes out typed — so a daemon whose `ls` drifted
 * from `@fleet/foundation-contracts` fails here rather than drawing blanks.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { FleetError } from '@fleet/foundation-core'

import { callDaemon, callerFor } from '../src/client.ts'
import { lsFixture, peerFixture } from './fixtures.ts'

/** A daemon that answers `ls` with whatever this test tells it to answer with. */
interface FakeRequest {
  readonly id?: string
  readonly method?: string
  readonly params?: unknown
}

const fakeDaemon = async (
  socketPath: string,
  reply: (request: FakeRequest) => unknown,
): Promise<Server> => {
  const server = createServer((connection) => {
    connection.setEncoding('utf8')
    let buffer = ''
    connection.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(buffer.slice(0, newline)) as FakeRequest
      connection.end(`${JSON.stringify(reply(request))}\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return server
}

describe('client: one request, one answer', () => {
  let dir = ''
  let socketPath = ''
  let server: Server | undefined

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-view-test-'))
    socketPath = join(dir, 'fleetd.sock')
  })

  after(async () => {
    server?.close()
    await rm(dir, { recursive: true, force: true })
  })

  const answerWith = async (result: unknown): Promise<void> => {
    server?.close()
    server = await fakeDaemon(socketPath, (request) => ({ id: request.id, ok: true, result }))
  }

  it('decodes an `ls` answer into the contract`s own shapes', async () => {
    const expected = lsFixture([peerFixture({ peerId: 'engineer-1' })])
    await answerWith(expected)
    const result = await callDaemon({ socketPath }, 'ls', {})
    assert.equal(result.status.profile, 'firstrun')
    assert.deepEqual(result.peers.map((peer) => peer.peerId), ['engineer-1'])
  })

  it('sends the method it was asked for, with its params', async () => {
    let seen: unknown
    server?.close()
    server = await fakeDaemon(socketPath, (request) => {
      seen = request
      return { id: request.id, ok: true, result: { messages: [] } }
    })
    await callDaemon({ socketPath }, 'peek', { peer: 'engineer-1' as never })
    assert.deepEqual(seen, { id: 'peek', method: 'peek', params: { peer: 'engineer-1' } })
  })

  it("surfaces a daemon's refusal as that refusal, not as an empty answer", async () => {
    server?.close()
    server = await fakeDaemon(socketPath, (request) => ({
      id: request.id,
      ok: false,
      error: { code: 'invalid_input', message: 'no peer engineer-9 in this fleet' },
    }))
    await assert.rejects(
      () => callDaemon({ socketPath }, 'ls', {}),
      (error: unknown) => {
        assert.ok(error instanceof FleetError)
        assert.equal(error.code, 'invalid_input')
        assert.match(error.message, /no peer engineer-9/)
        return true
      },
    )
  })

  it('refuses an answer that does not match the contract', async () => {
    await answerWith({ status: { profile: 'firstrun' }, peers: [] })
    await assert.rejects(() => callDaemon({ socketPath }, 'ls', {}), /does not match|ls result/)
  })

  it('says it cannot reach a socket that is not there, with the path in the message', async () => {
    await assert.rejects(
      () => callDaemon({ socketPath: join(dir, 'nobody.sock') }, 'ls', {}),
      (error: unknown) => {
        assert.ok(error instanceof FleetError)
        assert.equal(error.code, 'external_failed')
        assert.match(error.message, /cannot reach fleetd at .*nobody\.sock/)
        return true
      },
    )
  })

  it('a caller is the same call, bound to one socket', async () => {
    await answerWith(lsFixture([]))
    const call = callerFor({ socketPath })
    const result = await call('ls', {})
    assert.deepEqual(result.peers, [])
  })
})
