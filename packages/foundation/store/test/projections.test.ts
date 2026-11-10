/**
 * The projections runner (architecture §3, §5.4, §6.1, §7). The read models the
 * Mailbox, the PM, the board and the CLI get are built by `append` and by a
 * replay, through the same reducer — so these tests hold the shapes, not the
 * implementation: what a peer's brief version is, what a message's ack state
 * becomes, how a failure recurses onto one notification key.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PeerId } from '@fleet/foundation-core'
import type { AppendEvent } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore } from '../src/index.ts'
import { appendable, fixedClock, fixtureLog, tempStorePath } from './fixtures.ts'

const open = (): Promise<EventStore> => openSqliteStore({ path: tempStorePath(), clock: fixedClock })

/** A hand-written event; the append boundary still validates it, strictly. */
const event = (
  type: string,
  subject: string,
  data: Readonly<Record<string, unknown>>,
  ts = '2026-11-10T10:00:00.000Z',
  actor = 'pm',
): AppendEvent => ({ ts, type, subject, actor, data }) as unknown as AppendEvent

test('the golden corpus replays into a read model of every projection', async () => {
  const store = await open()
  await store.append(fixtureLog())
  const reader = store.reader()

  const peers = await reader.peers.all()
  assert.deepEqual(
    peers.map((peer) => peer.peerId),
    ['engineer-1'],
    'only a registered peer exists; a provider error about an unregistered one does not invent it',
  )
  const engineer = peers[0]
  assert.equal(engineer?.state, 'failed', 'the last state the supervisor wrote')
  assert.equal(engineer?.briefVersion, 1, 'the version §12 published for it')
  assert.equal(engineer?.currentSessionId, undefined, 'the session ended, so the peer has none')
  assert.equal(engineer?.worktreeId, 'wtr_5e6f708192a3b4c5')

  const sessions = await reader.sessions.forPeer('engineer-1' as PeerId)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]?.endedAt, '2026-11-10T09:05:00.000Z')
  assert.equal(sessions[0]?.endReason, 'purged')

  const work = await reader.work.all()
  assert.equal(work.length, 1, 'a transition for a Work no event proposed has nothing to update')
  assert.equal(work[0]?.state, 'cleaned')
  assert.deepEqual(work[0]?.prs, [{ repo: 'backbase/me-services-fleet', number: 42 }])
  assert.deepEqual(work[0]?.dependsOn, ['wrk_8a4b02d3e95c1f67'])
  assert.equal(work[0]?.briefId, 'brf_3c4d5e6f708192a3')

  const decisions = await reader.decisions.all()
  assert.equal(decisions[0]?.state, 'answered')
  assert.equal(decisions[0]?.option, 'yes')
  assert.equal(decisions[0]?.judgeModel, 'claude-sonnet-5-5')
  assert.deepEqual(await reader.decisions.open(), [])

  const messages = await reader.messages.all()
  assert.equal(messages.length, 1, 'a rejection for a message that was never sent has no row to update')
  assert.equal(messages[0]?.msgId, 'msg_4d5e6f708192a3b4')
  assert.equal(messages[0]?.state, 'acked', 'sent → delivered → acked, in log order')
  assert.equal(messages[0]?.ackedAt, '2026-11-10T09:31:00.000Z')

  const routines = await reader.routines.all()
  assert.deepEqual(
    routines.map((routine) => ({ id: routine.routineId, state: routine.state, runs: routine.runs })),
    [{ id: 'dispatch', state: 'finished', runs: 1 }],
  )

  const findings = await reader.findings.all()
  assert.equal(findings[0]?.state, 'dismissed')
  assert.equal(findings[0]?.seenCount, 2, 'raised once, seen once')
  assert.equal(findings[0]?.workId, 'wrk_8a4b02d3e95c1f67', 'routed to the Work that will act on it')

  const pullRequests = await reader.pullRequests.all()
  assert.equal(pullRequests.length, 1)
  assert.equal(pullRequests[0]?.merged, true)
  assert.equal(pullRequests[0]?.checks, 'failing')
  assert.deepEqual(pullRequests[0]?.failingChecks, ['build', 'integration/postgres'])

  assert.deepEqual(await reader.worktrees.all(), [], 'the corpus creates a worktree and then removes it')

  await store.close()
})

test('the message projection is the ack state machine §7 reads', async () => {
  const store = await open()
  const msgId = 'msg_4d5e6f708192a3b4'
  await store.append([appendable('message.sent.json')])
  const pending = await store.reader().messages.forPeer('engineer-1' as PeerId)
  assert.equal(pending[0]?.state, 'pending')
  assert.equal(pending[0]?.deliveredAt, undefined)

  await store.append([appendable('message.delivered.json'), appendable('message.acked.json')])
  const acked = await store.reader().messages.forPeer('engineer-1' as PeerId)
  assert.equal(acked[0]?.state, 'acked')
  assert.equal(acked[0]?.deliveredAt, '2026-11-10T09:30:00.000Z')
  assert.equal(acked[0]?.ackedAt, '2026-11-10T09:31:00.000Z')

  // A reply that cited an older brief is rejected, and the version to re-send
  // against is kept so the Mailbox can re-attach it (§7).
  await store.append([
    event('message.rejected', msgId, {
      msgId,
      to: 'engineer-1',
      reason: 'stale_brief',
      briefVersion: 1,
      currentBriefVersion: 2,
    }),
  ])
  const rejected = await store.reader().messages.forPeer('engineer-1' as PeerId)
  assert.equal(rejected[0]?.state, 'rejected')
  assert.equal(rejected[0]?.currentBriefVersion, 2)

  await store.close()
})

test('a decision routed to the user opens one notification, and the answer closes it', async () => {
  const store = await open()
  const decisionId = 'dec_6f708192a3b4c5d6'
  await store.append([
    event('decision.requested', decisionId, {
      decisionId,
      kind: 'scope',
      question: 'Ship the retarget before the gate rework?',
      options: ['yes', 'no'],
      inputsHash: 'sha256:6f1c2d3e4f5061728394a5b6c7d8e9f0',
    }),
  ])

  const pending = await store.reader().notifications.get('decision:dec_6f708192a3b4c5d6' as never)
  assert.equal(pending?.state, 'pending', 'derived by the projection, sent by the notify routine later')
  assert.equal(pending?.class, 'decision')
  assert.equal((await store.reader().decisions.open()).length, 1)

  await store.append([
    event('decision.answered', decisionId, {
      decisionId,
      source: 'user',
      option: 'yes',
      durationMs: 0,
    }),
  ])
  const resolved = await store.reader().notifications.get('decision:dec_6f708192a3b4c5d6' as never)
  assert.equal(resolved?.state, 'resolved')
  assert.equal(resolved?.resolvedAt, '2026-11-10T10:00:00.000Z')
  assert.deepEqual(await store.reader().decisions.open(), [])

  await store.close()
})

test('a decision a Judge can answer notifies nobody', async () => {
  const store = await open()
  const decisionId = 'dec_6f708192a3b4c5d6'
  await store.append([
    event('decision.requested', decisionId, {
      decisionId,
      kind: 'same_feature',
      question: 'Is "retarget stacked PRs" the same feature as FLEET-14?',
      options: ['yes', 'no'],
      inputsHash: 'sha256:6f1c2d3e4f5061728394a5b6c7d8e9f0',
      routedTo: 'judge:claude-sonnet-5-5',
    }),
  ])
  assert.deepEqual(await store.reader().notifications.all(), [])
  await store.close()
})

test('a failure that recurs keeps one notification key and counts the occurrences', async () => {
  const store = await open()
  const failed = (ts: string): AppendEvent =>
    event(
      'peer.failed',
      'engineer-1',
      { peerId: 'engineer-1', reason: 'session_died', retryable: true },
      ts,
      'peer:engineer-1',
    )
  await store.append([appendable('peer.registered.json')])
  await store.append([failed('2026-11-10T10:00:00.000Z')])
  await store.append([failed('2026-11-10T16:30:00.000Z')])

  const notifications = await store.reader().notifications.all()
  assert.equal(notifications.length, 1, 'one row per key, however often it recurs (§6.1)')
  assert.equal(notifications[0]?.key, 'failure:engineer-1:session_died')
  assert.equal(notifications[0]?.class, 'failure')
  assert.equal(notifications[0]?.occurrences, 2)
  assert.equal(notifications[0]?.createdAt, '2026-11-10T10:00:00.000Z', 'created when it was first seen')

  assert.equal((await store.reader().peers.get('engineer-1' as PeerId))?.state, 'failed')
  await store.close()
})

test('a routine counts its runs and its failures', async () => {
  const store = await open()
  await store.append([
    event('routine.started', 'dispatch', { routineId: 'dispatch', kind: 'dispatch', trigger: 'heartbeat' }),
    event('routine.finished', 'dispatch', { routineId: 'dispatch', kind: 'dispatch', durationMs: 41, actions: 0 }),
    event('routine.started', 'dispatch', { routineId: 'dispatch', kind: 'dispatch', trigger: 'heartbeat' }, '2026-11-10T10:05:00.000Z'),
  ])

  const [dispatch] = await store.reader().routines.all()
  assert.equal(dispatch?.runs, 2, 'a run is counted when it starts, so a crashed run is still visible')
  assert.equal(dispatch?.state, 'running')
  assert.equal(dispatch?.lastRunAt, '2026-11-10T10:05:00.000Z')
  assert.equal(dispatch?.failures, 0)

  await store.append([
    event(
      'routine.failed',
      'worktree-gc',
      { routineId: 'worktree-gc', kind: 'worktree-gc', error: 'git worktree list exited 128' },
      '2026-11-10T10:06:00.000Z',
    ),
  ])
  const routines = await store.reader().routines.all()
  assert.deepEqual(
    routines.map((routine) => routine.routineId),
    ['dispatch'],
    'a failure for a routine that never started has no row to count against',
  )

  await store.close()
})

test('a worktree is created, classified, and gone once it is removed', async () => {
  const store = await open()
  const worktreeId = 'wtr_5e6f708192a3b4c5'
  await store.append([
    event('worktree.created', worktreeId, {
      worktreeId,
      repo: 'backbase/me-services-fleet',
      branch: 'feature/retarget',
      path: '/tmp/fleet/feature-retarget',
      ownerPeerId: 'engineer-1',
      class: 'active',
    }),
  ])
  assert.equal((await store.reader().worktrees.all())[0]?.class, 'active')

  await store.append([appendable('worktree.classified.json')])
  const [classified] = await store.reader().worktrees.all()
  assert.equal(classified?.class, 'orphaned')
  assert.equal(classified?.dirty, true)
  assert.deepEqual(classified?.holders, [{ pid: 48213, command: 'node --test' }])

  await store.append([appendable('worktree.removed.json')])
  assert.deepEqual(await store.reader().worktrees.all(), [])
  await store.close()
})

test('a re-raised finding is the same row, counted again', async () => {
  const store = await open()
  await store.append([appendable('finding.raised.json')])
  await store.append([
    event(
      'finding.raised',
      'fnd_708192a3b4c5d6e7',
      {
        ...appendable('finding.raised.json').data,
        // The same rule, shifted a few lines down the file: §6.2 keys on the fingerprint.
        line: 128,
        sha: '3ee0e67a1b2c3d4e5f60718293a4b5c6d7e8f901',
      },
      '2026-11-10T11:00:00.000Z',
    ),
  ])

  const findings = await store.reader().findings.all()
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.seenCount, 2)
  assert.equal(findings[0]?.line, 128, 'the newest sighting wins the line')
  assert.equal(findings[0]?.raisedAt, '2026-11-10T09:52:00.000Z', 'the row keeps when it was raised')
  await store.close()
})

test("a published brief is the version the Mailbox compares a reply against", async () => {
  const store = await open()
  await store.append([appendable('peer.registered.json')])
  assert.equal((await store.reader().peers.get('engineer-1' as PeerId))?.briefVersion, 0)

  await store.append([appendable('brief.published.json')])
  const peer = await store.reader().peers.get('engineer-1' as PeerId)
  // 0 means "no brief yet": the Mailbox reads `undefined` until one is published (§7, §12).
  assert.equal(peer?.briefVersion, 1)
  await store.close()
})
