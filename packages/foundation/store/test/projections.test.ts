/**
 * The projections runner (architecture §3, §5.4, §6.1, §7). The read models the
 * Mailbox, the PM, the board and the CLI get are built by `append` and by a
 * replay, through the same reducer — so these tests hold the shapes, not the
 * implementation: what a peer's brief version is, what a message's ack state
 * becomes, how a failure recurses onto one notification key.
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { FleetError, type PeerId, type WorkId } from '@fleet/foundation-core'
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

/** The misses a projection recorded, read straight from the table until `health()` exposes them. */
const anomalies = (path: string): readonly unknown[] => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT event_seq, projection, event_type, subject, detail, at
           FROM projection_anomalies ORDER BY event_seq, projection`,
      )
      .all()
      .map((row) => ({ ...row }))
  } finally {
    db.close()
  }
}

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

  // `all()` is the same rows the per-peer read returns, in one call: a `FleetState` needs every session (§5.2),
  // and gathering it peer by peer made the snapshot's cost a function of the fleet's size.
  assert.deepEqual(await reader.sessions.all(), sessions, 'every session, and the same ones `forPeer` gives')

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
  // Which session it went to is kept, not just that it went: it is how a
  // restarted fleetd knows a peer is already looking at this message (§7).
  assert.equal(acked[0]?.deliveredSessionId, 'ses_1a2b3c4d5e6f7081')

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
    event('routine.finished', 'dispatch', {
      routineId: 'dispatch',
      kind: 'dispatch',
      durationMs: 41,
      actions: 0,
      actionsFailed: 0,
    }),
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

test('a routine that keeps failing raises one failure notification, and its recovery resolves it', async () => {
  const store = await open()
  const failing = (ts: string, error: string): AppendEvent =>
    event(
      'routine.failing',
      'dispatch',
      { routineId: 'dispatch', kind: 'dispatch', error, failures: 3, retryAt: '2026-11-10T10:00:40.000Z' },
      ts,
    )

  await store.append([
    event(
      'routine.started',
      'dispatch',
      { routineId: 'dispatch', kind: 'dispatch', trigger: 'heartbeat' },
      '2026-11-10T10:00:00.000Z',
    ),
  ])
  await store.append([failing('2026-11-10T10:00:10.000Z', 'remote said 500')])

  const raised = await store.reader().notifications.all()
  assert.equal(raised.length, 1)
  assert.equal(raised[0]?.key, 'failure:dispatch:dispatch')
  assert.equal(raised[0]?.class, 'failure', 'a broken routine is §6.1 failure class, the loud one')
  assert.equal(raised[0]?.state, 'pending')
  assert.match(raised[0]?.title ?? '', /dispatch keeps failing/)
  // The key can only name the routine; what broke and when it is tried again are
  // the two things a person needs, so the row carries them (§6.1).
  assert.match(raised[0]?.body ?? '', /remote said 500/)
  assert.match(raised[0]?.body ?? '', /next retry is 2026-11-10T10:00:40.000Z/)

  await store.append([failing('2026-11-10T10:05:00.000Z', 'the token is expired')])
  const repeated = await store.reader().notifications.all()
  assert.equal(repeated.length, 1, 'one row per routine, however often it recurs (§6.1)')
  assert.equal(repeated[0]?.occurrences, 2)

  await store.append([
    event(
      'routine.finished',
      'dispatch',
      { routineId: 'dispatch', kind: 'dispatch', durationMs: 12, actions: 0, actionsFailed: 0 },
      '2026-11-10T10:10:00.000Z',
    ),
  ])
  const recovered = await store.reader().notifications.all()
  assert.equal(recovered[0]?.state, 'resolved', 'a routine that finished has recovered')
  assert.equal(recovered[0]?.resolvedAt, '2026-11-10T10:10:00.000Z')
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

test("a published brief becomes the Work's current brief without moving its state", async () => {
  const store = await open()
  await store.append([appendable('peer.registered.json'), appendable('work.proposed.json'), appendable('work.ready.json')])
  const before = await store.reader().work.get('wrk_7f3a91c2d84b0e56' as WorkId)
  assert.equal(before?.briefId, undefined)

  await store.append([appendable('brief.published.json')])
  const after = await store.reader().work.get('wrk_7f3a91c2d84b0e56' as WorkId)
  assert.equal(after?.briefId, 'brf_3c4d5e6f708192a3')
  assert.equal(after?.briefVersion, 1)
  assert.equal(after?.state, before?.state, 'publishing a brief is not an assignment')
  await store.close()
})

test('sessions.all() is every session the fleet has, oldest first, in one read', async () => {
  const store = await open()
  await store.append([
    appendable('peer.registered.json'),
    appendable('session.started.json'),
    // a second peer, so `all()` cannot be satisfied by the per-peer answer of the first
    event('peer.registered', 'engineer-2', {
      peerId: 'engineer-2',
      role: 'engineer',
      providerId: 'claude-code',
      model: 'claude-sonnet-5-5',
      permissionMode: 'acceptEdits',
    }),
    event(
      'session.started',
      'ses_9f8e7d6c5b4a3928',
      {
        sessionId: 'ses_9f8e7d6c5b4a3928',
        peerId: 'engineer-2',
        providerId: 'claude-code',
        providerSessionRef: 'ref-9f8e7d6c',
        model: 'claude-sonnet-5-5',
        permissionMode: 'acceptEdits',
        resumed: false,
      },
      '2026-11-10T11:00:00.000Z',
    ),
  ])

  const all = await store.reader().sessions.all()
  assert.equal(all.length, 2, 'both peers, without asking for either one')
  assert.deepEqual(
    all.map((session) => session.peerId),
    ['engineer-1', 'engineer-2'],
    'ordered by when they started, so the snapshot does not depend on how the rows were written',
  )
  assert.deepEqual(await store.reader().sessions.all(), [
    ...(await store.reader().sessions.forPeer('engineer-1' as PeerId)),
    ...(await store.reader().sessions.forPeer('engineer-2' as PeerId)),
  ])
})

test('a blocked Work says who can unblock it, and only while it is blocked', async () => {
  const store = await open()
  const workId = 'wrk_4a5b6c7d8e9f0a1b' as WorkId
  await store.append([
    event('work.proposed', workId, { workId, title: 'Ship the store', dependsOn: [] }),
    event('work.blocked', workId, {
      workId,
      reason: 'the shared contract is not published yet',
      blockedOn: 'contract',
    }),
  ])

  const blocked = await store.reader().work.get(workId)
  assert.equal(blocked?.state, 'blocked')
  assert.equal(blocked?.blockedReason, 'the shared contract is not published yet')
  assert.equal(blocked?.blockedOn, 'contract', '§5.2 `unblock` routes on this field, not on the prose')

  // a replay has to reproduce it: the field lives in the event, so it survives `rebuild` (§5.4)
  await store.rebuild()
  assert.equal((await store.reader().work.get(workId))?.blockedOn, 'contract')

  await store.append([event('work.ready', workId, { workId, reason: 'the contract is published' })])
  const ready = await store.reader().work.get(workId)
  assert.equal(ready?.state, 'ready')
  assert.equal(ready?.blockedOn, undefined, 'a Work that is no longer blocked has nobody to route to')
  await store.close()
})

test('`work.cleaned` finishes a merged Work, and refuses to move any other (§5.1, §9)', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  const merged = 'wrk_1a2b3c4d5e6f7081' as WorkId
  const cancelled = 'wrk_2b3c4d5e6f708192' as WorkId
  const repo = 'acme/widgets'
  await store.append([
    event('work.proposed', merged, { workId: merged, title: 'collect the checkouts', dependsOn: [] }),
    event('work.proposed', cancelled, { workId: cancelled, title: 'wire the mailer', dependsOn: [] }),
    event('work.cancelled', cancelled, { workId: cancelled, reason: 'the mailer shipped in another Work' }),
  ])
  await store.append([
    event('work.merged', merged, {
      workId: merged,
      pr: { repo, number: 12 },
      headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    }),
  ])

  // The two producers that emit this event (§9's `worktree-gc`, §10's `branch-cleanup`)
  // both answer "the checkout is gone"; neither is allowed to answer "the Work is
  // finished" for a Work a person dropped. `cancelled` is terminal and is theirs, so the
  // projection refuses the step even though the log cannot: `events` is append-only.
  await store.append([
    event('work.cleaned', merged, { workId: merged }),
    event('work.cleaned', cancelled, { workId: cancelled }),
  ])

  assert.equal((await store.reader().work.get(merged))?.state, 'cleaned', '§5.1’s last step, for the Work that merged')
  assert.equal(
    (await store.reader().work.get(cancelled))?.state,
    'cancelled',
    'a person’s “drop this” survives the collector that came past the checkout',
  )

  const recorded = [
    {
      event_seq: 6,
      projection: 'work',
      event_type: 'work.cleaned',
      subject: cancelled,
      detail: `refused work.cleaned: state is cancelled, not merged`,
      at: '2026-11-10T10:00:00.000Z',
    },
  ]
  assert.deepEqual(await anomalies(path), recorded, 'the refusal is a row, not a silence `fleet status` cannot see')
  assert.equal((await store.health()).anomalies, 1)

  // The guard is in the reducer, so append and rebuild agree about the log (§5.4): a replay
  // lands on the same state and regenerates exactly the same one anomaly.
  await store.rebuild()
  assert.equal((await store.reader().work.get(cancelled))?.state, 'cancelled')
  assert.equal((await store.reader().work.get(merged))?.state, 'cleaned')
  assert.deepEqual(await anomalies(path), recorded)
  assert.equal((await store.health()).anomalies, 1, 'a replay lands on the same count, not zero and not two')
  await store.close()
})

test('an event about an entity the log never opened is recorded, not silently dropped', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  // `events` is append-only, so this cannot be refused at the boundary; and the projection
  // has no row to write. Dropping it quietly would make a broken log look like a healthy one.
  const absent = 'wrk_ffffffffffffffff' as WorkId
  await store.append([
    event('work.started', absent, { workId: absent, peerId: 'engineer-1', sessionId: 'ses_1a2b3c4d5e6f7081' }),
  ])

  assert.equal((await store.health()).anomalies, 1, 'the count `fleet status` reads is the row above')
  const recorded = [
    {
      event_seq: 1,
      projection: 'work',
      event_type: 'work.started',
      subject: absent,
      detail: `no work row for ${absent}`,
      at: '2026-11-10T10:00:00.000Z',
    },
  ]
  assert.deepEqual(await anomalies(path), recorded)
  assert.equal(await store.reader().work.get(absent), undefined, 'the miss is recorded, not invented')

  // The row is itself a projection, keyed `(seq, projection)`: a replay has to land on exactly
  // the same one, or `append` and `rebuild` would disagree about how sick the log is (§5.4).
  await store.rebuild()
  assert.deepEqual(await anomalies(path), recorded)
  assert.equal((await store.health()).anomalies, 1, 'a replay lands on the same count, not zero and not two')
  await store.close()
})

test('`strictProjection` turns a miss into a throw, and keeps none of the batch', async () => {
  const store = await openSqliteStore({ path: tempStorePath(), clock: fixedClock, strictProjection: true })
  const absent = 'wrk_eeeeeeeeeeeeeeee' as WorkId
  const miss = event('work.started', absent, { workId: absent, peerId: 'engineer-1', sessionId: 'ses_1a2b3c4d5e6f7081' })

  await assert.rejects(
    () => store.append([appendable('peer.registered.json'), miss]),
    (thrown: unknown) =>
      thrown instanceof FleetError &&
      thrown.code === 'store_failed' &&
      /strictProjection: 1 projection miss/.test(thrown.message) &&
      thrown.message.includes(`no work row for ${absent}`),
    'the message names the miss, so a test does not have to go and read the table to find it',
  )

  assert.deepEqual(await store.health(), { latestSeq: 0, events: 0, anomalies: 0, compactions: 0 }, 'the whole batch rolled back')
  assert.equal(await store.reader().peers.get('engineer-1' as PeerId), undefined, 'including the event that did project')

  // Strict about misses, not about logs: an event every projection can follow still lands.
  await store.append([appendable('peer.registered.json')])
  await store.rebuild()
  assert.deepEqual(await store.health(), { latestSeq: 1, events: 1, anomalies: 0, compactions: 0 })
  await store.close()
})

test('a compaction is one row a peer, and every one of them raises its own notification', async () => {
  const store = await open()
  await store.append([appendable('peer.registered.json')])
  await store.append([
    event('peer.compacted', 'engineer-1', { peerId: 'engineer-1', trigger: 'auto', preTokens: 180_000 }),
  ])
  await store.append([
    event(
      'peer.compacted',
      'engineer-1',
      { peerId: 'engineer-1', trigger: 'manual', preTokens: 90_000, estimatedCostUsd: 0.27 },
      '2026-11-10T11:00:00.000Z',
    ),
  ])
  await store.append([
    event('peer.compacted', 'architect-1', { peerId: 'architect-1', trigger: 'auto', preTokens: 40_000 }),
  ])

  const rows = await store.reader().compactions.all()
  assert.deepEqual(rows, [
    {
      peerId: 'architect-1',
      count: 1,
      lastAt: '2026-11-10T10:00:00.000Z',
      lastTrigger: 'auto',
      lastPreTokens: 40_000,
    },
    {
      peerId: 'engineer-1',
      count: 2,
      lastAt: '2026-11-10T11:00:00.000Z',
      lastTrigger: 'manual',
      lastPreTokens: 90_000,
    },
  ])

  // §6.1 `failure`: one notification per compaction, not one per peer. A key
  // built from the peer alone would have deduped the second one away, which is
  // the exact silence the alert exists to break.
  const raised = (await store.reader().notifications.all()).filter((row) => String(row.key).includes('compacted'))
  assert.equal(raised.length, 3)
  assert.deepEqual(
    raised.map((row) => row.class),
    ['failure', 'failure', 'failure'],
  )

  // The same rows after a replay: the table is a projection of the log, not state
  // `append` kept on the side.
  await store.rebuild()
  assert.deepEqual(await store.reader().compactions.all(), rows)
  assert.equal((await store.health()).compactions, 3, 'health counts them too, which is what `fleet status` reads')
  await store.close()
})

test('a compaction says whether the configured limit was the reason, which is the whole alert', async () => {
  const store = await open()
  await store.append([appendable('peer.registered.json')])
  // The same trigger and the same peer three times over: only the numbers differ,
  // and the numbers are what a reader needs to act on. A banner that only said
  // "compacted" would leave the one question it exists to answer — is the limit
  // I configured wrong for this model? — to the user.
  await store.append([
    event('peer.compacted', 'engineer-1', {
      peerId: 'engineer-1',
      trigger: 'auto',
      preTokens: 40_000,
      contextLimit: 200_000,
    }),
  ])
  await store.append([
    event('peer.compacted', 'engineer-1', {
      peerId: 'engineer-1',
      trigger: 'auto',
      preTokens: 200_000,
      contextLimit: 200_000,
    }),
  ])
  // A provider that reports no window at all (§4): nothing to compare against,
  // and saying "too low" or "too high" here would be inventing the comparison.
  await store.append([
    event('peer.compacted', 'engineer-1', { peerId: 'engineer-1', trigger: 'manual', preTokens: 90_000 }),
  ])

  const raised = (await store.reader().notifications.all())
    .filter((row) => String(row.key).includes('compacted'))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  assert.equal(raised.length, 3)

  // Named with the model, from the peer row: the limit that is wrong is the
  // limit *for this model*, so the alert has to say which one.
  assert.match(raised[0]?.body ?? '', /engineer-1 \(claude-sonnet-5-5\)/)
  assert.match(raised[0]?.body ?? '', /40,000 tokens/)
  assert.match(raised[0]?.body ?? '', /configured limit is too high for this model/)

  assert.match(raised[1]?.body ?? '', /200,000 tokens/)
  assert.match(raised[1]?.body ?? '', /limit fits this model/)

  assert.match(raised[2]?.body ?? '', /no context limit/)

  await store.close()
})

test('a turn adds its price to the Work and to the peer rollup, and an unpriced turn adds nothing', async () => {
  const store = await open()
  await store.append([
    event('peer.registered', 'engineer-1', {
      peerId: 'engineer-1',
      role: 'engineer',
      providerId: 'claude-code',
      model: 'claude-sonnet-5-5',
      permissionMode: 'acceptEdits',
      worktreeId: 'wtr_5e6f708192a3b4c5',
    }),
  ])

  const turn = (workId: string | undefined, costUsd: number | undefined, ts: string): AppendEvent[] => [
    event(
      'turn.usage_recorded',
      'engineer-1',
      {
        peerId: 'engineer-1',
        sessionId: 'ses_1a2b3c4d5e6f7081',
        ...(workId === undefined ? {} : { workId }),
        contextTokens: 172_400,
        contextLimit: 200_000,
        inputTokens: 61_200,
        outputTokens: 4_180,
        cachedTokens: 148_000,
        toolCalls: { grep: 0, glob: 0, read: 0, codegraph: 0 },
        ...(costUsd === undefined ? {} : { costUsd }),
      },
      ts,
    ),
  ]

  await store.append(turn('wrk_7f3a91c2d84b0e56', 0.42, '2026-11-10T10:00:00.000Z'))
  // A provider that prices nothing: the turn still counts, the spend does not move.
  await store.append(turn('wrk_7f3a91c2d84b0e56', undefined, '2026-11-10T10:01:00.000Z'))

  const rows = await store.reader().tokens.all()
  const work = rows.find((row) => row.workId === 'wrk_7f3a91c2d84b0e56')
  const rollup = rows.find((row) => row.workId === undefined)

  assert.equal(work?.role, 'engineer', 'the role comes from the peer row, not the event')
  assert.equal(work?.turns, 2)
  assert.equal(work?.costUsd, 0.42, 'an unknown cost is not a free one, and not a new price either')

  assert.equal(rollup?.turns, 2, 'the rollup counts every turn the peer ran')
  assert.equal(rollup?.inputTokens, 122_400)
  assert.equal(rollup?.costUsd, 0.42, 'the rollup sums what was actually priced')

  await store.close()
})

/** A turn as `turn.usage_recorded` records it, priced or not, at `ts`. */
const usage = (costUsd: number | undefined, ts: string): AppendEvent =>
  event(
    'turn.usage_recorded',
    'engineer-1',
    {
      peerId: 'engineer-1',
      contextTokens: 1_000,
      contextLimit: 200_000,
      inputTokens: 100,
      outputTokens: 10,
      cachedTokens: 0,
      toolCalls: { grep: 0, glob: 0, read: 0, codegraph: 0 },
      ...(costUsd === undefined ? {} : { costUsd }),
    },
    ts,
  )

const SPEND_LOG: readonly AppendEvent[] = [
  usage(1.5, '2026-10-30T09:00:00.000Z'),
  // 01:00 on the 1st in UTC+2 is still October in UTC, which is the month the cap is kept in.
  usage(0.25, '2026-11-01T01:00:00.000+02:00'),
  usage(2, '2026-11-01T00:00:00.000Z'),
  usage(undefined, '2026-11-10T10:00:00.000Z'),
  usage(0.5, '2026-11-10T11:00:00.000Z'),
]

test("a month's spend is the sum of that month's turns in UTC, and an unpriced turn is counted as one", async () => {
  const store = await open()
  await store.append([...SPEND_LOG])
  const reader = store.reader()

  assert.deepEqual(await reader.tokens.month('2026-10'), { month: '2026-10', costUsd: 1.75, turns: 2, unpricedTurns: 0 })
  assert.deepEqual(await reader.tokens.month('2026-11'), { month: '2026-11', costUsd: 2.5, turns: 3, unpricedTurns: 1 })
  assert.deepEqual(
    await reader.tokens.month('2026-12'),
    { month: '2026-12', costUsd: 0, turns: 0, unpricedTurns: 0 },
    'a month with no turns spent nothing, which is an answer, not a miss',
  )

  await store.rebuild()
  assert.deepEqual(await reader.tokens.month('2026-11'), { month: '2026-11', costUsd: 2.5, turns: 3, unpricedTurns: 1 })
  await store.close()
})

test("a store upgraded from schema 8 has this month's spend at once, not after its next rebuild", async () => {
  const path = tempStorePath()
  const before = await openSqliteStore({ path, clock: fixedClock })
  await before.append([...SPEND_LOG])
  await before.close()

  // What a store written by the previous build looks like: the log, and no table.
  const db = new DatabaseSync(path)
  db.exec("DROP TABLE spend_by_month; UPDATE store_meta SET value = '8' WHERE key = 'schema_version';")
  db.close()

  const after = await openSqliteStore({ path, clock: fixedClock })
  const reader = after.reader()
  assert.deepEqual(await reader.tokens.month('2026-10'), { month: '2026-10', costUsd: 1.75, turns: 2, unpricedTurns: 0 })
  assert.deepEqual(await reader.tokens.month('2026-11'), { month: '2026-11', costUsd: 2.5, turns: 3, unpricedTurns: 1 })
  await after.close()
})

const standardsSet = (version: number, digest: string, ts = '2026-11-10T09:02:00.000Z'): AppendEvent =>
  event(
    'peer.standards_set',
    'engineer-1',
    {
      peerId: 'engineer-1',
      version,
      briefId: `brf_${String(version).padStart(16, '0')}`,
      digest,
      sources: [{ name: 'AGENTS.md', chars: 120, truncated: false, ref: 'abc1234' }],
      skipped: [],
    },
    ts,
    'pm',
  )

const digestA = 'a'.repeat(64)
const digestB = 'b'.repeat(64)

test('peer.standards_set moves the peer’s briefVersion, which is what the Mailbox judges mail against (§7, §12.1)', async () => {
  const store = await open()
  await store.append([appendable('peer.registered.json')])
  assert.equal((await store.reader().peers.get('engineer-1' as never))?.briefVersion, 0)

  await store.append([standardsSet(1, digestA)])
  assert.equal((await store.reader().peers.get('engineer-1' as never))?.briefVersion, 1)
  await store.append([standardsSet(2, digestB)])
  assert.equal((await store.reader().peers.get('engineer-1' as never))?.briefVersion, 2)
})

test('a standards version that does not go up is an anomaly and leaves the peer’s version alone', async () => {
  const store = await open()
  await store.append([appendable('peer.registered.json'), standardsSet(3, digestA)])
  await store.append([standardsSet(3, digestB), standardsSet(2, digestB, '2026-11-10T09:03:00.000Z')])

  assert.equal((await store.reader().peers.get('engineer-1' as never))?.briefVersion, 3)
  assert.equal((await store.health()).anomalies, 2)
})

test('latest(type, subject) is the newest event of that type about that subject, or nothing', async () => {
  const store = await open()
  assert.equal(await store.latest('peer.standards_set', 'engineer-1'), undefined)

  await store.append([appendable('peer.registered.json'), standardsSet(1, digestA), standardsSet(2, digestB, '2026-11-10T09:03:00.000Z')])
  const latest = await store.latest('peer.standards_set', 'engineer-1')
  assert.equal(latest?.type === 'peer.standards_set' && latest.data.digest, digestB)
  assert.equal(await store.latest('peer.standards_set', 'engineer-2'), undefined, 'another subject has none')
  assert.equal(await store.latest('peer.registered', 'engineer-1').then((e) => e?.type), 'peer.registered')
})

test('a Judge question is one row, and the answer fills it in rather than replacing it', async () => {
  const store = await open()
  const questionId = 'qst_2b7c9d1e4f6a8b0c'
  await store.append([
    event('judge.requested', questionId, {
      questionId,
      kind: 'thin_card',
      input: { kind: 'thin_card', title: 'Retarget the stacked children', goal: 'Keep the stack honest.', acceptance: [] },
      inputsHash: 'sha256:4c1d7e9a0b2f3568',
    }),
  ])

  const asked = await store.reader().judge.get(questionId as never)
  assert.equal(asked?.askedAt, '2026-11-10T10:00:00.000Z')
  assert.equal(asked?.answer, undefined, 'asked, not yet answered: the row exists either way')

  await store.append([
    event(
      'judge.answered',
      questionId,
      {
        questionId,
        kind: 'thin_card',
        answer: { kind: 'thin_card', thin: false, missing: [], why: 'It names the goal and its acceptance.' },
        model: 'claude-haiku-4-5',
        durationMs: 900,
        retries: 0,
      },
      undefined,
      'judge:claude-haiku-4-5',
    ),
  ])

  const answered = await store.reader().judge.get(questionId as never)
  assert.equal(answered?.answer?.kind, 'thin_card')
  assert.equal(answered?.model, 'claude-haiku-4-5')
  assert.equal(answered?.answeredAt, '2026-11-10T10:00:00.000Z')
  assert.equal(answered?.askedAt, '2026-11-10T10:00:00.000Z', 'the question keeps when it was asked')
  assert.equal((await store.reader().judge.all()).length, 1, 'an answer is not a second question')
})

test('an answer with no question on file is an anomaly, not an invented question', async () => {
  const path = tempStorePath()
  const store = await openSqliteStore({ path, clock: fixedClock })
  const questionId = 'qst_9e8d7c6b5a493827'
  await store.append([
    event('judge.answered', questionId, {
      questionId,
      kind: 'thin_card',
      answer: { kind: 'thin_card', thin: true, missing: ['a goal'], why: 'the body is one line' },
      model: 'claude-haiku-4-5',
      durationMs: 700,
      retries: 0,
    }),
  ])

  assert.equal(await store.reader().judge.get(questionId as never), undefined)
  assert.deepEqual(await anomalies(path), [
    {
      event_seq: 1,
      projection: 'judge',
      event_type: 'judge.answered',
      subject: questionId,
      detail: `no judge row for ${questionId}`,
      at: '2026-11-10T10:00:00.000Z',
    },
  ])
  await store.close()
})
