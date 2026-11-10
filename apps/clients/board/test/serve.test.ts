/**
 * The board over a real listener on a real port, with the daemon replaced by a
 * function (§2). What matters here is the surface: one route, reads only, and a
 * daemon that is down is a page rather than a stack trace in a browser.
 */

import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { after, describe, it } from 'node:test'

import { fleetError } from '@fleet/foundation-core'
import type { DaemonMethod } from '@fleet/foundation-contracts'

import type { Caller } from '../src/client.ts'
import { serveBoard, type RunningBoard } from '../src/serve.ts'
import { lsFixture, statusFixture, workFixture } from './fixtures.ts'

const AT = '2026-11-10T12:00:00.000Z'

const running: RunningBoard[] = []
after(async () => {
  await Promise.all(running.splice(0).map((board) => board.stop()))
})

/** A fleet of one peer and two Work items, and a record of what was asked. */
const caller = (): { readonly call: Caller; readonly asked: DaemonMethod[] } => {
  const asked: DaemonMethod[] = []
  const call = async (method: DaemonMethod) => {
    asked.push(method)
    if (method === 'ls') return lsFixture()
    if (method === 'work') {
      return {
        work: [
          workFixture({ workId: 'wrk_00000000000000a1', title: 'Say which phase the board is in', state: 'ready' }),
          workFixture({ workId: 'wrk_00000000000000a2', state: 'blocked', blockedReason: 'waiting on a decision' }),
        ],
      }
    }
    throw fleetError('invalid_input', `the board reads ls and work, not ${method}`)
  }
  return { call: call as unknown as Caller, asked }
}

const serve = async (
  options: { readonly call?: Caller; readonly socketPath?: string; readonly host?: string } = {},
): Promise<RunningBoard> => {
  const board = await serveBoard({
    socketPath: options.socketPath ?? statusFixture().socketPath,
    host: options.host ?? '127.0.0.1',
    // 0: the OS picks a free port, so a suite and a person's board never collide.
    port: 0,
    call: options.call ?? caller().call,
    now: () => AT,
  })
  running.push(board)
  return board
}

describe('board over http: one read-only route', () => {
  it('serves the page at / from `ls` and `work`, and nothing else was asked', async () => {
    const { call, asked } = caller()
    const board = await serve({ call })

    const response = await fetch(board.url)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(body, /fleet firstrun/)
    assert.match(body, /2 work items/)
    assert.match(body, /Say which phase the board is in/)
    assert.match(body, /waiting on a decision/)
    assert.deepEqual(asked.sort(), ['ls', 'work'])
  })

  it('answers 404 for anything but /: the board is not a web server', async () => {
    const board = await serve()
    const response = await fetch(new URL('/work/wrk_00000000000000a1', board.url))
    assert.equal(response.status, 404)
    assert.match(await response.text(), /serves \/ and nothing else/)
  })

  it('answers 405 to a write, and says the board is read-only', async () => {
    const board = await serve()
    const response = await fetch(board.url, { method: 'POST', body: '{}' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
    assert.match(await response.text(), /read-only/)
  })

  it('answers 503 with a readable page when fleetd is not there', async () => {
    const down = (async () => {
      throw fleetError('external_failed', 'cannot reach fleetd at /x/fleetd.sock: connect ENOENT')
    }) as unknown as Caller
    const board = await serve({ call: down, socketPath: '/x/fleetd.sock' })

    const response = await fetch(board.url)
    assert.equal(response.status, 503)
    assert.match(await response.text(), /connect ENOENT/)
  })

  it('re-reads the daemon on every request instead of caching a page', async () => {
    const { call, asked } = caller()
    const board = await serve({ call })
    await (await fetch(board.url)).text()
    await (await fetch(board.url)).text()
    assert.deepEqual(asked, ['ls', 'work', 'ls', 'work'])
  })
})

/**
 * A request whose `Host` line we choose. `fetch` refuses to set one (it is a
 * forbidden header), and that header is the whole of the attack: a hostile
 * page re-points its own name at 127.0.0.1, the browser sends
 * `Host: board.attacker.example`, and the page's origin still looks like the
 * attacker's — so unless the board checks the name, its rows are readable from
 * a page that has no business reading them.
 */
const send = (
  board: RunningBoard,
  options: { readonly host?: string; readonly setHost?: boolean; readonly path?: string } = {},
): Promise<{ readonly status: number; readonly body: string }> => {
  const url = new URL(board.url)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: options.path ?? '/',
        method: 'GET',
        ...(options.setHost === false
          ? { setHost: false }
          : { headers: { host: options.host ?? url.host } }),
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body })
        })
      },
    )
    request.on('error', reject)
    request.end()
  })
}

describe('board over http: it answers for its own host and no other', () => {
  it('refuses a foreign Host, and never asks the daemon for the page', async () => {
    const { call, asked } = caller()
    const board = await serve({ call })

    const response = await send(board, { host: 'board.attacker.example' })

    assert.equal(response.status, 403)
    assert.match(response.body, /host/i)
    // refusing after the read would still have leaked nothing, but it would
    // still have hit the daemon for a request the board will not answer
    assert.deepEqual(asked, [])
  })

  it('refuses a foreign Host even with the port and the case a browser would send', async () => {
    const board = await serve()
    const response = await send(board, { host: 'Board.Attacker.Example:7777' })
    assert.equal(response.status, 403)
  })

  it('allows 127.0.0.1 and localhost, with or without a port', async () => {
    const board = await serve()
    const port = new URL(board.url).port

    assert.equal((await send(board, { host: `127.0.0.1:${port}` })).status, 200)
    assert.equal((await send(board, { host: '127.0.0.1' })).status, 200)
    assert.equal((await send(board, { host: `localhost:${port}` })).status, 200)
    assert.equal((await send(board, { host: 'LOCALHOST' })).status, 200)
  })

  it('allows the configured host when it is not loopback', async () => {
    // binding every interface is the one configuration where the address a
    // browser uses is not one of the loopback names
    const board = await serve({ host: '0.0.0.0' })
    const port = new URL(board.url).port

    assert.equal((await send(board, { host: `0.0.0.0:${port}` })).status, 200)
    assert.equal((await send(board, { host: `127.0.0.1:${port}` })).status, 200)
    assert.equal((await send(board, { host: 'board.attacker.example' })).status, 403)
  })

  it('refuses a request with no Host at all: nothing to verify is not a pass', async () => {
    const { call, asked } = caller()
    const board = await serve({ call })
    const response = await send(board, { setHost: false })
    // node's own parser answers 400 to an HTTP/1.1 request with no Host; which
    // layer refuses it matters less than that the page is not served and the
    // daemon is not read for a request the board cannot attribute a name to
    assert.ok(response.status >= 400, `expected a refusal, got ${String(response.status)}`)
    assert.deepEqual(asked, [])
  })

  it('answers the host check before the route check, so a 404 never confirms a page exists', async () => {
    const board = await serve()
    const response = await send(board, { host: 'board.attacker.example', path: '/work/wrk_00000000000000a1' })
    assert.equal(response.status, 403)
  })
})
