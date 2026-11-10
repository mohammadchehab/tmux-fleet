/**
 * §4 and §13: where a DeepInfra key lives, and everywhere it must not.
 *
 * The token is the one credential the fleet handles at all, so the assertion is
 * two-sided and both halves matter. It has to *reach* the peer — a start that
 * quietly loses it is a fleet whose peers cannot talk to their endpoint — and it
 * must reach nothing else: not an event, not an error the daemon reports back,
 * not an error's details. A test that only checked the first half would pass on
 * a daemon that wrote the key into the log.
 *
 * The provider under `deepinfra` is the scripted fake, so the env the supervisor
 * built is what gets recorded on the spec; the real adapter's half (its endpoint,
 * its pinned model keys) is tested in `apps/daemon/test/deepinfra-env.test.ts`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSandbox } from '../support/sandbox.ts'
import { DEFAULT_DEEPINFRA_TOKEN_ENV, defaultDeepInfraTokenFile } from '../../../apps/daemon/src/deepinfra-env.ts'

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
/** Not a key, and shaped so that a substring search cannot be a coincidence. */
const TOKEN = 'not-a-real-deepinfra-key-7f3a9c'

test('§4: a DeepInfra peer is started with the key, and the key reaches nothing else', async (t) => {
  const sandbox = await createSandbox({
    peers: [{ id: 'engineer-1', role: 'engineer', provider: 'deepinfra', model: MODEL }],
    environ: { [DEFAULT_DEEPINFRA_TOKEN_ENV]: TOKEN },
  })
  t.after(() => sandbox.stop())

  await sandbox.call('up')

  // The half that proves the other half is not vacuous: the key did get through.
  const [session] = sandbox.scripted.sessions
  assert.ok(session !== undefined)
  assert.equal(session.spec.env.ANTHROPIC_AUTH_TOKEN, TOKEN)
  assert.equal(session.spec.env.ANTHROPIC_MODEL, MODEL)
  assert.equal(session.spec.env.FLEET_PEER, 'engineer-1')

  // §3's log is what `fleet ls`, `peek` and every routine read. Nothing in it
  // may quote the key — not a session event, not a peer registration, not a
  // failure's details.
  const events = await sandbox.events()
  assert.ok(events.length > 0, 'the fleet wrote something, so the search means something')
  for (const event of events) {
    assert.ok(
      !JSON.stringify(event).includes(TOKEN),
      `${event.type} carries the key in its payload: ${JSON.stringify(event)}`,
    )
  }
})

test('§4: no key anywhere fails `fleet up` by name — the variable and the file, never a value', async (t) => {
  const sandbox = await createSandbox({
    peers: [{ id: 'engineer-1', role: 'engineer', provider: 'deepinfra', model: MODEL }],
    // Nothing set, and the profile names no file of its own, so the default is
    // looked for under the sandbox's temp `$XDG_CONFIG_HOME` and is not there.
    environ: {},
  })
  t.after(() => sandbox.stop())

  const expectedFile = defaultDeepInfraTokenFile(sandbox.paths.configHome)
  await assert.rejects(sandbox.call('up'), (thrown: unknown) => {
    const error = thrown as Error & { code?: string }
    assert.equal(error.code, 'config_mismatch')
    assert.match(error.message, new RegExp(DEFAULT_DEEPINFRA_TOKEN_ENV))
    assert.ok(error.message.includes(expectedFile), 'the message names the file it looked for')
    return true
  })

  // A start that never happened: no session, and nothing registered.
  assert.equal(sandbox.scripted.sessions.length, 0)
  const events = await sandbox.events()
  assert.equal(events.filter((event) => event.type === 'session.started').length, 0)
})
