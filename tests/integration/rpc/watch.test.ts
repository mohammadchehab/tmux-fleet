/**
 * `fleet watch` and the daemon, over a real socket (watch-and-attach §6, §7).
 *
 * The CLI has its own stream client and its own frame decoder, so "does it read
 * `peer.watch` the way the daemon writes it" is a question neither side answers
 * alone. `tests/integration` may import both.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { callerFor } from '../../../apps/clients/cli/src/client.ts'
import { run } from '../../../apps/clients/cli/src/run.ts'
import { openWatch } from '../../../apps/clients/cli/src/watch/stream.ts'
import { createSandbox } from '../support/sandbox.ts'

test('watch --once and the stream read the same fleet the daemon holds', async (t) => {
  const sandbox = await createSandbox()
  t.after(() => sandbox.stop())
  const call = callerFor({ socketPath: sandbox.paths.socketPath })
  await call('up', {})
  const listing = await call('ls', {})

  const out: string[] = []
  const code = await run(['node', 'fleet', 'watch', '--once', '--socket', sandbox.paths.socketPath], {
    call: (socketPath) => callerFor({ socketPath }),
    out: (text) => out.push(text),
    err: (text) => out.push(text),
    env: {},
  })
  assert.equal(code, 0)
  for (const peer of listing.peers) assert.ok(out.join('\n').includes(String(peer.peerId)), `the table names ${String(peer.peerId)}`)

  // The stream's first word after the history is `ready`, with the daemon's protocol version.
  const ready = await new Promise<{ stream: string; protocolVersion?: number }>((resolve, reject) => {
    const handle = openWatch({
      socketPath: sandbox.paths.socketPath,
      onFrame: (frame) => {
        if (frame.stream === 'ready') {
          resolve(frame)
          handle.close()
        }
      },
      onClose: (error) => reject(error ?? new Error('closed before ready')),
    })
  })
  assert.equal(ready.protocolVersion, listing.status.protocolVersion)
})
