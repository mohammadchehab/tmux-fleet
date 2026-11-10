/**
 * §5.1's Work state machine, advanced from the log (§5.2).
 *
 * The store is the real one, for the same reason `wake.test.ts` uses it: the claim
 * is about a projection as it stands *after* a committed batch, and a fake reader
 * would let a test pass against a state the store would never have. The clock is
 * fixed so a test can name the instant a transition was stamped with.
 *
 * The PR here is the projection, not the forge: these tests write `pr.*` events and
 * read the Work back. Whether those PR events are true is `pr-babysit`'s question
 * and its test's; this file only owns the translation onto the Work.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { BriefId, Clock, MessageId, PeerId, ProviderSessionRef, Repo, SessionId, Sha, Timestamp } from '@fleet/foundation-core'
import type { AppendEvent, WorkId } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore } from '@fleet/foundation-store'

import { createWakingSink } from '../src/wake.ts'
import { catchUpWork, syncWork, type WorkSyncDeps } from '../src/work-sync.ts'

const roots = await mkdtemp(join(tmpdir(), 'fleet-work-sync-'))
after(async () => {
  await rm(roots, { recursive: true, force: true })
})

const TS = '2026-11-10T09:00:00.000Z' as Timestamp
const clock: Clock = { now: () => TS, millis: () => Date.parse(TS) }
const repo = 'acme/widgets' as Repo
const peer = 'engineer-1' as PeerId
const workId = 'wrk_0000000000000001' as WorkId
const SHA = 'a'.repeat(40) as Sha
const sessionId = 'ses_0000000000000001' as SessionId

/** A message the Mailbox accepted and then delivered — the two events §7 writes in order. */
const delivered = (kind: 'brief' | 'info'): readonly AppendEvent[] => {
  const msgId = 'msg_0000000000000001' as MessageId
  return [
    { ts: TS, type: 'message.sent', subject: msgId, actor: 'pm', data: { msgId, to: peer, from: 'pm', kind, briefVersion: 1, body: 'the thing' } },
    { ts: TS, type: 'message.delivered', subject: msgId, actor: 'scheduler', data: { msgId, to: peer, sessionId } },
  ]
}

let counter = 0

/** A store with the listener attached, so an append is a full wake (§5.2). */
const harness = async (): Promise<{
  readonly store: EventStore
  readonly append: (batch: readonly AppendEvent[]) => Promise<readonly unknown[]>
  readonly types: () => Promise<readonly string[]>
}> => {
  const store = await openSqliteStore({ path: join(roots, `store-${(counter += 1)}.sqlite`), clock })
  await store.migrate()

  const sink = createWakingSink({
    append: (batch) => store.append(batch),
    read: (from, limit) => store.read(from, limit),
    // No scheduler: these tests judge the listener, and a stopped daemon runs neither.
    scheduler: () => ({ wake: async () => undefined }),
  })
  const deps: WorkSyncDeps = { read: store.reader(), append: sink.append, clock }
  sink.listen(syncWork(deps))

  return {
    store,
    append: sink.append,
    // What the listener appended is whatever landed beyond the caller's own batch;
    // the log is the only honest record, so it is read rather than recorded.
    types: async () => (await store.read(0, 10_000)).map((event) => event.type),
  }
}

/** A Work in the state the briefs executor would have left it in (§5.2, §12). */
const assign = (id: WorkId = workId, to: PeerId = peer): readonly AppendEvent[] => [
  {
    ts: TS,
    type: 'work.proposed',
    subject: id,
    actor: 'user',
    data: { workId: id, title: 'a thing that needs doing', role: 'engineer', dependsOn: [] },
  },
  { ts: TS, type: 'work.ready', subject: id, actor: 'scheduler', data: { workId: id } },
  {
    ts: TS,
    type: 'work.assigned',
    subject: id,
    actor: 'pm',
    data: { workId: id, peerId: to, briefId: 'brf_0000000000000001' as BriefId, briefVersion: 1 },
  },
]

const opened = (id: WorkId = workId, number = 7): AppendEvent => ({
  ts: TS,
  type: 'pr.opened',
  subject: `${repo}#${String(number)}`,
  actor: 'scheduler',
  data: { pr: { repo, number }, base: 'main', head: `work/${String(id)}`, headSha: SHA, workId: id },
})

const checks = (state: 'passing' | 'pending' | 'failing', number = 7): AppendEvent => ({
  ts: TS,
  type: 'pr.checks_changed',
  subject: `${repo}#${String(number)}`,
  actor: 'scheduler',
  data: { pr: { repo, number }, headSha: SHA, state, failing: state === 'failing' ? ['lint'] : [] },
})

const review = (state: 'approved' | 'pending', number = 7): AppendEvent => ({
  ts: TS,
  type: 'pr.review_changed',
  subject: `${repo}#${String(number)}`,
  actor: 'scheduler',
  data: { pr: { repo, number }, headSha: SHA, state },
})

const merged = (number = 7): AppendEvent => ({
  ts: TS,
  type: 'pr.merged',
  subject: `${repo}#${String(number)}`,
  actor: 'scheduler',
  data: { pr: { repo, number }, headSha: SHA },
})

const stateOf = async (store: EventStore, id: WorkId = workId): Promise<string | undefined> =>
  (await store.reader().work.get(id))?.state

test('§5.1: a brief that reaches its assignee is a Work that has started', async () => {
  const { store, append } = await harness()
  await append(assign())

  await append(delivered('brief'))

  assert.equal(await stateOf(store), 'in_progress')
})

test('§5.1: a message that is not a brief starts nothing', async () => {
  const { store, append } = await harness()
  await append(assign())

  await append(delivered('info'))

  assert.equal(await stateOf(store), 'assigned')
})

test('§5.1: a resume starts the Work the peer was already assigned', async () => {
  const { store, append } = await harness()
  await append(assign())

  await append([
    { ts: TS, type: 'peer.registered', subject: peer, actor: 'scheduler', data: { peerId: peer, role: 'engineer', providerId: 'claude', model: 'test-small', permissionMode: 'default' } },
    { ts: TS, type: 'session.started', subject: sessionId, actor: 'scheduler', data: { peerId: peer, sessionId, providerId: 'claude', providerSessionRef: 'ref-1' as ProviderSessionRef, model: 'test-small', permissionMode: 'default', resumed: true } },
  ])

  assert.equal(await stateOf(store), 'in_progress')
})

test('§5.1: a PR with the Work footer puts the Work in review', async () => {
  const { store, append } = await harness()
  await append(assign())
  await append([opened()])

  const work = (await store.reader().work.get(workId)) as { state: string; prs: readonly unknown[] }
  assert.equal(work.state, 'in_review')
  assert.equal(work.prs.length, 1, 'the Work remembers the PR it is waiting on')
})

test('§5.1: a PR without a Work footer changes no Work', async () => {
  const { store, append } = await harness()
  await append(assign())
  await append([
    { ts: TS, type: 'pr.opened', subject: `${repo}#7`, actor: 'scheduler', data: { pr: { repo, number: 7 }, base: 'main', head: 'x', headSha: SHA } },
  ])

  assert.equal(await stateOf(store), 'assigned')
})

test('§6.10: green checks and an approval make the Work mergeable, in either order', async () => {
  const { store, append } = await harness()
  await append(assign())
  await append([opened()])

  // Checks first: they are green but the review is not yet in.
  await append([checks('passing')])
  assert.equal(await stateOf(store), 'in_review', 'green checks alone are not mergeable (§10)')

  await append([review('approved')])
  assert.equal(await stateOf(store), 'mergeable')
})

test('§10: an approval on failing checks leaves the Work in review', async () => {
  const { store, append } = await harness()
  await append(assign())
  await append([opened(), checks('failing'), review('approved')])

  assert.equal(await stateOf(store), 'in_review')
})

test('§10: red checks after a green run take a mergeable Work back to review, not to merged', async () => {
  const { store, append } = await harness()
  await append(assign())
  await append([opened(), checks('passing'), review('approved')])
  assert.equal(await stateOf(store), 'mergeable')

  // A head that goes red is not a state this file invents: §5.1 has no way back from
  // `mergeable`, so the Work stays there and the PM's `gate` rule refuses to merge.
  await append([checks('failing')])
  assert.equal(await stateOf(store), 'mergeable')
})

test('§5.1: the gate merging the PR merges the Work, once', async () => {
  const { store, append, types } = await harness()
  await append(assign())
  await append([opened(), checks('passing'), review('approved'), merged()])

  assert.equal(await stateOf(store), 'merged')
  const all = await types()
  assert.equal(all.filter((type) => type === 'work.merged').length, 1, 'one transition, not one per event')
})

test('§5.1: an unmerged close is not a merge', async () => {
  const { store, append } = await harness()
  await append(assign())
  await append([opened(), checks('passing'), review('approved')])

  // Nothing in the log says the PR was closed; that the Work is still `mergeable`
  // is the honest reading, and `stale` is the PM's rule, not this listener's.
  assert.equal(await stateOf(store), 'mergeable')
})

test('a PR that names a Work nobody assigned is not reviewable', async () => {
  const { store, append } = await harness()
  await append([{ ts: TS, type: 'work.proposed', subject: workId, actor: 'user', data: { workId, title: 'unowned', dependsOn: [] } }])
  await append([opened()])

  assert.equal(await stateOf(store), 'proposed')
})

/**
 * A store with no listener attached: what fleetd leaves behind while it is down.
 * Events land in the log and in the projections, and nothing translates them.
 */
const detached = async (): Promise<{
  readonly store: EventStore
  readonly off: (batch: readonly AppendEvent[]) => Promise<readonly unknown[]>
  readonly catchUp: () => ReturnType<typeof catchUpWork>
}> => {
  const store = await openSqliteStore({ path: join(roots, `detached-${(counter += 1)}.sqlite`), clock })
  await store.migrate()
  const deps: WorkSyncDeps = { read: store.reader(), append: (batch) => store.append(batch), clock }
  return {
    store,
    off: (batch) => store.append(batch),
    catchUp: () => catchUpWork(deps),
  }
}

/** Another store's log, as this one would have received it: `append` assigns the seq. */
const copyOf = async (store: EventStore): Promise<readonly AppendEvent[]> =>
  (await store.read(0, 10_000)).map(({ seq: _seq, ...event }) => event)

test('§5.2: a `pr.merged` that landed while fleetd was down is caught up at start', async () => {
  const { store, catchUp } = await detached()
  // Everything up to the merge happened with the fleet watching, so the Work is
  // `mergeable`; then the daemon is down for the one event that finishes it.
  const live = await harness()
  await live.append(assign())
  await live.append([opened(), checks('passing'), review('approved')])
  assert.equal(await stateOf(live.store), 'mergeable')
  await live.store.append([merged()])

  // Replay the same log into a store nobody is listening to: this is the state a
  // restart finds — a Work at `mergeable` whose PR is already merged, and no wake
  // left that will ever mention it.
  await store.append(await copyOf(live.store))
  assert.equal(await stateOf(store), 'mergeable')
  assert.equal((await store.reader().pullRequests.all()).find((pr) => pr.number === 7)?.merged, true)

  const batch = await catchUp()
  assert.deepEqual(
    batch.map((event) => event.type),
    ['work.merged'],
    'only the missing transition, not a replay of the ones that happened',
  )
  assert.equal(await stateOf(store), 'merged')
})

test('§5.2: the catch-up appends nothing when the translation already happened', async () => {
  const { store, catchUp } = await detached()
  const live = await harness()
  await live.append(assign())
  // The listener was attached for the merge, so `work.merged` is already written.
  await live.append([opened(), checks('passing'), review('approved'), merged()])
  assert.equal(await stateOf(live.store), 'merged')
  await store.append(await copyOf(live.store))

  const batch = await catchUp()

  assert.deepEqual(batch, [], 'a restart after the fact is a no-op')
  const all = (await store.read(0, 10_000)).map((event) => event.type)
  assert.equal(all.filter((type) => type === 'work.merged').length, 1, 'exactly one, still')
})

test('the catch-up is idempotent against its own write', async () => {
  const { store, catchUp } = await detached()
  await store.append(assign())
  await store.append([opened(), checks('passing'), review('approved'), merged()])

  const first = await catchUp()
  const second = await catchUp()

  assert.ok(first.length > 0, 'the first pass has work to do')
  assert.deepEqual(second, [], 'the second finds the Work caught up')
  const all = (await store.read(0, 10_000)).map((event) => event.type)
  assert.equal(all.filter((type) => type === 'work.merged').length, 1)
})

test('the catch-up carries a Work that never saw a checks/review event forward to mergeable', async () => {
  const { store, catchUp } = await detached()
  // A PR that went green and merged inside one downtime: the Work never left
  // `assigned`, and one pass has to walk it the whole way.
  await store.append(assign())
  await store.append([opened(), checks('passing'), review('approved'), merged()])

  const batch = await catchUp()

  assert.deepEqual(
    batch.map((event) => event.type),
    ['work.review_requested', 'work.mergeable', 'work.merged'],
    'the same three the listener would have written, in the same order',
  )
  assert.equal(await stateOf(store), 'merged')
})

test('a PR the projection does not say merged is not evidence a Work merged', async () => {
  const { store, catchUp } = await detached()
  await store.append(assign())
  await store.append([opened(), checks('passing'), review('approved')])

  const batch = await catchUp()

  assert.deepEqual(batch.map((event) => event.type), ['work.review_requested', 'work.mergeable'])
  assert.equal(await stateOf(store), 'mergeable')
})

test('a cancelled Work is not advanced by later PR events', async () => {
  const { store, append } = await harness()
  await append(assign())
  await append([
    { ts: TS, type: 'work.cancelled', subject: workId, actor: 'pm', data: { workId, reason: 'not needed' } },
    opened(),
  ])

  assert.equal(await stateOf(store), 'cancelled')
})
