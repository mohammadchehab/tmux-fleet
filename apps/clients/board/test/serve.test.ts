/**
 * The board over a real listener on a real port, with the daemon replaced by a
 * function (§2). What matters here is the surface: one route, reads only, and a
 * daemon that is down is a page rather than a stack trace in a browser.
 */

import assert from 'node:assert/strict'
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

const serve = async (options: { readonly call?: Caller; readonly socketPath?: string } = {}): Promise<RunningBoard> => {
  const board = await serveBoard({
    socketPath: options.socketPath ?? statusFixture().socketPath,
    host: '127.0.0.1',
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
