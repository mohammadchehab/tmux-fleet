/**
 * §15's third clause — "purges and resumes one engineer at its limit" — against
 * the real supervisor, the real purge and the real store.
 *
 * The peer is scripted, so the one thing "at its limit" can be is its reported
 * usage: the fake reports a context past `contextRatio` for the first session it
 * starts and a small one afterwards, which is exactly the shape of a real purge
 * (the fresh session starts empty).
 *
 * The state file is a *file*, not a reply (§8): the purge asks the peer for one
 * and then reads the path. So the scripted peer writes to the fleet's own path —
 * `~/.fleet/<profile>/peers/<peer>/state.md` — the way a real peer's Write tool
 * would, and nothing in the daemon parses text out of a provider event.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { createSandbox, until } from '../support/sandbox.ts'

const peer = { id: 'engineer-1', role: 'engineer', model: 'test-small' }

/** Past the daemon's 0.8 ratio for session 0 only, so the purge happens once. */
const firstSessionTooFull = (index: number) =>
  index === 0 ? { contextTokens: 900, contextLimit: 1_000 } : { contextTokens: 10, contextLimit: 1_000 }

test('§15: a peer at its limit purges, saves its state file and resumes on a fresh session', async (t) => {
  const sandbox = await createSandbox({ peers: [peer], scripted: { usage: firstSessionTooFull } })
  t.after(() => sandbox.stop())

  await sandbox.call('up')

  // The purge fires at the boundary of the brief turn, so `up` returns before it
  // has finished: the test waits for the observable end state, not a timer.
  await until(() => sandbox.scripted.sessions.length === 2, 'the session after the purge')

  const [first, fresh] = sandbox.scripted.sessions
  assert.ok(first && fresh)
  assert.equal(String(first.spec.peerId), 'engineer-1')
  assert.equal(first.spec.stateFile, undefined)

  // The fresh session starts *from* the handoff: same peer, same brief, the
  // state file the previous session wrote (§8).
  assert.equal(String(fresh.spec.peerId), 'engineer-1')
  assert.equal(fresh.spec.brief.version, 1)
  assert.ok(fresh.spec.stateFile, 'the fresh session is handed the state file')
  assert.equal(String(fresh.spec.stateFile.peerId), 'engineer-1')
  assert.ok(fresh.spec.stateFile.goal.length > 0)
  assert.equal(fresh.spec.stateFile.briefVersion, 1)

  // §8's four events, in order, and no degradation: the peer answered.
  const events = await sandbox.events()
  const purge = events.filter((event) => event.type.startsWith('purge.'))
  assert.deepEqual(
    purge.map((event) => event.type),
    ['purge.started', 'purge.saved', 'purge.completed'],
  )
  const completed = purge[2]
  assert.ok(completed)
  assert.equal(completed.data.fromSessionId, first.handle.sessionId)
  assert.equal(completed.data.toSessionId, fresh.handle.sessionId)

  // The peer was asked in the peer's own words, once (§8's ask is a turn).
  const asks = sandbox.scripted.turns.filter((turn) => turn.kind === 'nudge')
  assert.equal(asks.length, 1)
  assert.match(asks[0]?.text ?? '', /single fenced ```json block/)

  // The human copy is on disk at §1.1's path, rendered from what was validated.
  const stateMarkdown = await readFile(sandbox.stateFile('engineer-1'), 'utf8')
  assert.match(stateMarkdown, /engineer-1/)

  // `ls` shows the peer on the fresh session, not the one that was purged.
  const ls = await sandbox.call<{ peers: readonly { id: string; sessionId?: string }[] }>('ls')
  assert.equal(ls.peers.find((row) => row.id === 'engineer-1')?.sessionId, fresh.handle.sessionId)
})

test('§15: a peer that writes no state file degrades instead of losing the session', async (t) => {
  const sandbox = await createSandbox({
    peers: [peer],
    // The peer answers, twice, with something that is not a state file.
    scripted: { usage: firstSessionTooFull, stateFileFor: () => 'I am not a json block' },
  })
  t.after(() => sandbox.stop())

  await sandbox.call('up')
  await until(() => sandbox.scripted.sessions.length === 2, 'the session after the purge')

  const events = await sandbox.events()
  const types = events.filter((event) => event.type.startsWith('purge.')).map((event) => event.type)
  assert.deepEqual(types, ['purge.started', 'purge.degraded', 'purge.completed'])

  const degraded = events.find((event) => event.type === 'purge.degraded')
  assert.ok(degraded)
  assert.ok(String(degraded.data.reason).length > 0, 'the degradation says why')

  // Degraded is not lost: the fresh session still starts, from the facts the
  // store already had rather than from the peer's handoff (§8).
  const fresh = sandbox.scripted.sessions[1]
  assert.ok(fresh)
  assert.ok(fresh.spec.stateFile, 'a degraded purge still hands over a state file')
  assert.equal(String(fresh.spec.stateFile.peerId), 'engineer-1')
  assert.equal(sandbox.scripted.turns.filter((turn) => turn.kind === 'nudge').length, 2, 'asked twice, then stopped asking')
})
