/**
 * §15's exit test, clause by clause, against the real daemon.
 *
 * The fleet here is the production one: `compose()` wires the store, the
 * supervisor, the mailbox, the scheduler and the socket, and the client speaks
 * the daemon's real protocol (`rpcCall` over a Unix socket). Only the agent
 * behind the provider is scripted — see `support/scripted-provider.ts`.
 *
 * What each test is allowed to claim is deliberately narrow. A claim about
 * something the daemon does not do yet (delivery to a peer, `assign` executing,
 * a routine waking on an event) is a finding handed to the team, not an
 * assertion made red here: a test that fails because a feature is missing tests
 * the feature's absence once and then becomes noise. The gaps this harness
 * found are in the PR body.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { LsResult, PeekResult } from '../../../packages/foundation/contracts/src/index.ts'
// The other half of the contract this file checks: the hook and the daemon are
// separate apps, and only the tests may see both at once (§1.1).
import { buildReport } from '../../../apps/hooks/usage-report/src/report.ts'
import { createSandbox, until } from '../support/sandbox.ts'

/**
 * The wire shapes are the contract's, not this file's: `ls` answers with the §3
 * projections (`Peer`, `Routine`, `Decision`) and `peek` with §7's `Message`.
 * Importing the types rather than restating them is what makes a row that
 * gained a field a row this test reads, instead of a shape that quietly stops
 * describing the daemon.
 */
type LsLike = LsResult

/** One turn's transcript, in the shape Claude Code writes: a prompt, then the assistant's message. */
const ONE_TURN = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
  JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'done' }] },
  }),
].join('\n')

test('§15: a fleet comes up from a profile, and every peer is a real session', async (t) => {
  const sandbox = await createSandbox()
  t.after(() => sandbox.stop())

  const status = await sandbox.call<LsLike['status']>('up')
  assert.equal(status.profile, 'exit-test')
  assert.equal(status.socketPath, sandbox.paths.socketPath)

  // `up` starts the peers itself, so by the time it answers they are running.
  assert.equal(sandbox.scripted.sessions.length, 3, 'one session per peer the profile declares')

  const ls = await sandbox.call<LsLike>('ls')
  assert.deepEqual(
    ls.peers.map((peer) => peer.peerId).sort(),
    ['architect', 'engineer-1', 'engineer-2'],
  )
  for (const peer of ls.peers) {
    assert.equal(peer.providerId, 'claude')
    assert.equal(typeof peer.currentSessionId, 'string', `${peer.peerId} has a live session`)
  }
  // §6.1's inbox: nothing is waiting on the user in a fleet that just came up.
  assert.deepEqual(ls.decisions, [])

  // The spec is what a real provider would be handed: the peer's own directory,
  // the brief at version 1, and a permission mode that is not bypass (§13).
  const architect = sandbox.scripted.sessions[0]
  assert.ok(architect)
  assert.equal(architect.spec.role, 'architect')
  assert.equal(architect.spec.cwd, sandbox.paths.stateDir)
  assert.equal(architect.spec.brief.version, 1)
  assert.ok(architect.spec.brief.text.length > 0, 'the brief has text, not just a version')
  assert.equal(architect.spec.permissionMode, 'default')
  assert.equal(architect.spec.env.FLEET_PEER, 'architect')
  // §6.2's Stop hook is handed this env and skips unless it can reach the daemon
  // and compare the turn against a configured window. Both are the supervisor's
  // to provision, and for a long time it provisioned neither.
  assert.equal(architect.spec.env.FLEET_SOCKET, sandbox.paths.socketPath)
  assert.equal(architect.spec.env.FLEET_CONTEXT_LIMIT, String(sandbox.scripted.provider.contextLimit?.(architect.spec.model)))
  // And the env is only worth setting if the hook acts on it: fed a transcript
  // and this env, §6.2's report is built rather than skipped.
  const report = buildReport({ stopHookActive: false }, ONE_TURN, architect.spec.env)
  assert.equal(report.status, 'report', `the Stop hook would skip: ${report.status === 'skip' ? report.reason : ''}`)
  assert.equal(architect.spec.stateFile, undefined, 'a first session has nothing to resume from')

  // `fleet up` twice is one registration and three sessions, not six (§2).
  await sandbox.call('up')
  assert.equal(sandbox.scripted.sessions.length, 3)
  const again = await sandbox.call<LsLike>('ls')
  assert.equal(again.peers.length, 3)

  const events = await sandbox.events()
  const registered = events.filter((event) => event.type === 'peer.registered')
  assert.equal(registered.length, 3, 'exactly one peer.registered per peer')
})

test('§15: a peer killed mid-turn is recovered on a fresh session', async (t) => {
  const sandbox = await createSandbox({ scripted: { holdWork: true } })
  t.after(() => sandbox.stop())
  await sandbox.call('up')

  const before = await sandbox.call<LsLike>('ls')
  const killed = before.peers.find((peer) => peer.peerId === 'engineer-1')
  const killedSessionId = killed?.currentSessionId
  assert.ok(killedSessionId, 'engineer-1 is running')
  const killedSession = sandbox.scripted.session(killedSessionId)
  assert.ok(killedSession)

  // §15 kills a peer mid-turn. Delivery is not wired yet (see the PR body), so
  // the turn is started the way delivery would start it — through the provider
  // handle the supervisor holds — and then the process dies with it open.
  await sandbox.scripted.provider.send(killedSession.handle, {
    text: 'take the first ready work item',
    kind: 'info',
    briefVersion: 1,
  })
  await until(() => sandbox.scripted.openTurn(killedSessionId), 'the turn to start')
  sandbox.scripted.crash(killedSessionId)

  // The supervisor recovers: a new session for the same peer, from the same
  // spec, because there was no purge to hand off a state file (§7).
  const recovered = await until(
    () => sandbox.scripted.sessions.find((session) => session.index > 2),
    'a replacement session for engineer-1',
  )
  assert.equal(String(recovered.spec.peerId), 'engineer-1')
  assert.equal(recovered.spec.stateFile, undefined)
  assert.equal(recovered.spec.cwd, sandbox.paths.stateDir)

  const after = await sandbox.call<LsLike>('ls')
  const engineer = after.peers.find((peer) => peer.peerId === 'engineer-1')
  assert.equal(engineer?.currentSessionId, recovered.handle.sessionId, '`ls` shows the session that is running')
  assert.deepEqual([...sandbox.composed.supervisor.running()].sort(), ['architect', 'engineer-1', 'engineer-2'])

  // The peer is running again, on a session whose identity is not the dead one's.
  assert.notEqual(recovered.handle.sessionId, killedSessionId)

  // Not asserted, on purpose: a stream that *throws* records no `session.ended`
  // at all — the pump rethrows, `run()` recovers, and the store never says the
  // old session died. §15's "survives killing a peer session mid-turn" is met
  // (the peer works again), but the record is incomplete. Reported in the PR
  // body rather than asserted here: what is missing belongs to the supervisor's
  // owner, not to this harness.
})

test('§15: a message sent over the socket is the message the peer would read', async (t) => {
  const sandbox = await createSandbox()
  t.after(() => sandbox.stop())
  await sandbox.call('up')

  const sent = await sandbox.call<{ msgId: string }>('send', {
    to: 'engineer-2',
    kind: 'info',
    body: 'the third work item is ready',
  })
  assert.match(sent.msgId, /^msg_/)

  const peeked = await sandbox.call<PeekResult>('peek', { peer: 'engineer-2' })
  assert.equal(peeked.messages.length, 1)
  assert.equal(peeked.messages[0]?.msgId, sent.msgId)
  assert.equal(peeked.messages[0]?.body, 'the third work item is ready')
  assert.equal(peeked.messages[0]?.kind, 'info')
  // §7's own row, not a flattened copy of it: the version and the ack state
  // travel with the message, so `fleet peek` can say what the peer is on.
  assert.equal(peeked.messages[0]?.state, 'delivered', 'the peer\'s session was handed it')
  assert.equal(peeked.messages[0]?.briefVersion, 1)

  // A peer that does not exist is refused at the socket, with the daemon's own code.
  await assert.rejects(
    () => sandbox.call('send', { to: 'nobody', kind: 'info', body: 'hello' }),
    (error: Error & { code?: string }) => error.code === 'not_found',
  )

  // Nothing has acked it, so it is still the peer's to act on (§7): `peek`
  // reads the unacked box, and the row says where it got to.
  const unacked = await sandbox.call<PeekResult>('peek', { peer: 'engineer-2' })
  assert.deepEqual(
    unacked.messages.map((message) => message.state),
    ['delivered'],
    'delivered to the session, and not yet acked by the peer',
  )
})

test('§6.2: the turn boundary records what the turn spent, with no hook to install', async (t) => {
  const sandbox = await createSandbox()
  t.after(() => sandbox.stop())
  await sandbox.call('up')

  // The turn is started through the handle the supervisor holds, which is where
  // the boundary that follows belongs: under fleetd the measurer is the
  // supervisor, not a Stop hook in the session's own transcript.
  const session = sandbox.scripted.sessions.find((candidate) => String(candidate.spec.peerId) === 'engineer-1')
  assert.ok(session, 'engineer-1 has a session')
  await sandbox.scripted.provider.send(session.handle, {
    text: 'take the first ready work item',
    kind: 'info',
    briefVersion: 1,
  })

  // The brief is a turn too, so this session's work turn is the *second* row:
  // one row per boundary, not one row per session.
  const rows = await until(
    async () => {
      const all = await sandbox.events()
      const matching = all.filter(
        (event) => event.type === 'turn.usage_recorded' && event.data.sessionId === session.handle.sessionId,
      )
      return matching.length >= 2 ? matching : undefined
    },
    'the work turn to record what it spent',
  )
  assert.deepEqual(rows[0]?.data['toolCalls'], { grep: 0, glob: 0, read: 0, codegraph: 0 }, 'the brief used no tools')
  const recorded = rows[1]
  assert.ok(recorded, 'the work turn is the second row')

  // One row per turn, written by the fleet itself: the tokens the provider
  // counted (§6.2's `turn.usage`), the pressure the boundary saw, and the tools
  // the turn used counted from the stream rather than asked of the peer.
  assert.equal(recorded.subject, 'engineer-1', 'the row is the peer\'s, which is what `ls` and the purge read')
  assert.deepEqual(recorded.data, {
    peerId: 'engineer-1',
    sessionId: session.handle.sessionId,
    contextTokens: 10,
    contextLimit: 1_000,
    inputTokens: 1_200,
    outputTokens: 300,
    cachedTokens: 4_000,
    toolCalls: { grep: 1, glob: 0, read: 0, codegraph: 0 },
  })
  assert.equal('turnId' in recorded.data, false, 'keyed by session; the turn id is the stream\'s')

  // The scripted provider declares `usageCost: false`, and a provider that
  // prices nothing yields no `costUsd` — an absent field, not a zero (§6.2).
  assert.equal('costUsd' in recorded.data, false)

  // The row is the turn's, not the session's whole life: another turn appends
  // another row rather than updating the last one, so a fleet's spend is a sum
  // over rows and never a snapshot someone had to sample.
  await sandbox.scripted.provider.send(session.handle, {
    text: 'take the second ready work item',
    kind: 'info',
    briefVersion: 1,
  })
  const all = await until(
    async () => {
      const matching = (await sandbox.events()).filter(
        (event) => event.type === 'turn.usage_recorded' && event.data.sessionId === session.handle.sessionId,
      )
      return matching.length >= 3 ? matching : undefined
    },
    'the third turn to record its own row',
  )
  assert.equal(all.length, 3)
})

test('§15: `down` stops the loops, and the fleet is no longer reachable', async (t) => {
  const sandbox = await createSandbox()
  t.after(() => sandbox.stop())
  await sandbox.call('up')
  assert.equal(sandbox.composed.supervisor.running().length, 3)

  const answered = await sandbox.call<{ stopped: true }>('down')
  assert.deepEqual(answered, { stopped: true })

  // `down` answers before it goes away; the cleanup runs on the next tick.
  await until(() => sandbox.composed.supervisor.running().length === 0, 'the sessions to stop')
  assert.equal(sandbox.composed.daemon.running, false)
  await assert.rejects(() => sandbox.raw('ls'), /cannot reach fleetd/)

  const events = await sandbox.events()
  assert.equal(events.filter((event) => event.type === 'session.ended' && event.data.endReason === 'stopped').length, 3)
})
