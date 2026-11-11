/**
 * `down` answers the client, then `onDown` tears the process down. If that
 * teardown throws after `daemon.down()` has already said ok, the failure must be
 * logged and the store and lock still released — otherwise the next `fleet up`
 * cannot start on the same store (§2, TASK-48).
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { compose } from '../src/wiring/compose.ts'

const PROFILE = `profile: test
repos: [acme/widgets]
peers:
  - id: engineer-1
    role: engineer
    provider: claude
    model: claude-sonnet-5-5
`

const askDown = (socketPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const client = connect(socketPath)
    let buffer = ''
    client.setEncoding('utf8')
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

describe('onDown error handling', () => {
  it('logs a failed teardown, still releases the store and the lock, and still exits', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fleet-ondown-'))
    const configHome = join(home, '.config')
    const holding = setInterval(() => undefined, 1_000)
    const originalError = console.error
    try {
      await mkdir(join(configHome, 'fleet', 'profiles'), { recursive: true })
      await writeFile(join(configHome, 'fleet', 'profiles', 'test.yaml'), PROFILE, 'utf8')

      let done!: () => void
      const exited = new Promise<void>((resolve) => {
        done = resolve
      })
      const composed = await compose({ profileName: 'test', roots: { home, configHome }, exit: () => done() })

      // The first close in onDown fails; the cleanup path's own close must still run.
      const realClose = composed.store.close.bind(composed.store)
      const realRelease = composed.lock.release.bind(composed.lock)
      let closes = 0
      let released = 0
      composed.store.close = async () => {
        closes += 1
        if (closes === 1) throw new Error('store.close failed: disk error')
        await realClose()
      }
      composed.lock.release = async () => {
        released += 1
        await realRelease()
      }

      const errors: string[] = []
      console.error = (...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(' '))
      }

      const reply = await askDown(composed.server.address)
      assert.match(reply, /"ok":true/, 'the client is answered before the teardown fails')
      await exited

      assert.ok(errors.some((line) => /failed to shut down cleanly.*disk error/.test(line)), `the failure is logged: ${errors.join(' | ')}`)
      assert.equal(closes, 2, 'the store is closed again after the failed close')
      assert.equal(released, 1, 'the lock is released')
    } finally {
      console.error = originalError
      clearInterval(holding)
      await rm(home, { recursive: true, force: true })
    }
  })
})
