/**
 * fleetd over a real store and a real Mailbox (§2, §3, §7).
 *
 * The store is the SQLite one, not a fake: `up` is judged by the events it
 * appended, and an event the real store would refuse is a test that should
 * fail here rather than in production. The supervisor and the scheduler are
 * fakes because they start processes and timers; the daemon's job is to call
 * them in the right order, which is exactly what they record.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  err,
  FleetError,
  fleetError,
  newDecisionId,
  ok,
  persistentDirs,
  profilePaths,
  type BriefId,
  type DecisionId,
  type MessageId,
  type PeerId,
  type Repo,
  type Seq,
  type Sha,
  type SessionId,
  type WorkId,
  type TurnId,
} from '@fleet/foundation-core'
import type { AppendEvent, PeerSessionLease, Turn } from '@fleet/foundation-contracts'
import { createDaemonBuilds } from '../src/wiring/builds.ts'
import { openSqliteStore, type EventStore } from '@fleet/foundation-store'
import { createMailbox } from '@fleet/runtime-mailbox'
import type { Scheduler } from '@fleet/orchestration-routines'

import { createDaemon } from '../src/wiring/daemon.ts'
import type { Supervisor } from '../src/execution/sessions.ts'
import type { Profile } from '../src/config/profile.ts'

const roots = await mkdtemp(join(tmpdir(), 'fleet-daemon-'))
after(async () => {
  await rm(roots, { recursive: true, force: true })
})

let counter = 0
const pathsFor = () => profilePaths(`test-${(counter += 1)}`, { home: roots, configHome: roots })

const profile = (): Profile => ({
  profile: 'test',
  repos: [],
  peers: [
    { id: 'engineer-1' as PeerId, role: 'engineer', provider: 'claude', model: 'sonnet' },
    { id: 'architect' as PeerId, role: 'architect', provider: 'claude', model: 'opus' },
  ],
})

const fakeSupervisor = (
  options: { readonly reachable?: boolean } = {},
): Supervisor & {
  readonly log: readonly string[]
  readonly sent: readonly string[]
  /** Bring the session up (or take it away) mid-test, so "queued, then delivered on resume" is one scenario. */
  online(value: boolean): void
} => {
  const log: string[] = []
  const sent: string[] = []
  let reachable = options.reachable !== false
  let sessions = 0
  return {
    log,
    sent,
    online(value: boolean) {
      reachable = value
    },
    async start() {
      log.push('supervisor.start')
    },
    async stop() {
      log.push('supervisor.stop')
    },
    async acquire(peer: PeerId) {
      // A registered peer whose session is not running: §7's "resume-then-deliver"
      // answers this with a typed `not_found`, which the Mailbox reports as
      // `no_session` and leaves the message pending.
      if (!reachable) {
        return err(
          fleetError('not_found', `peer ${String(peer)} has no running session`, { details: { peerId: String(peer) } }),
        )
      }
      // A real session id, because the Mailbox writes it into `message.delivered`
      // and the store's append boundary checks it against the contract.
      sessions += 1
      const lease: PeerSessionLease = {
        sessionId: `ses_${String(sessions).padStart(16, '0')}` as SessionId,
        resumed: false,
        async send(turn: Turn): Promise<TurnId> {
          sent.push(turn.text)
          return `trn_${String(sent.length)}` as TurnId
        },
      }
      return ok(lease)
    },
    briefs: {
      // Only a peer the profile declares has a brief; any other id resolves to
      // none, which is how a caller learns it named no one (§7).
      async current(peer: PeerId) {
        return profile().peers.some((declared) => declared.id === peer) ? 2 : undefined
      },
    },
    running() {
      return [] as readonly PeerId[]
    },
  }
}

const fakeScheduler = (order: string[] = []): Scheduler & { readonly log: readonly string[] } => {
  const log: string[] = []
  return {
    log,
    plan: { routines: [], installed: [], unimplemented: [] },
    async start() {
      log.push('scheduler.start')
      order.push('scheduler.start')
      return []
    },
    stop() {
      log.push('scheduler.stop')
      order.push('scheduler.stop')
    },
    async tick() {
      return []
    },
    async wake() {
      return []
    },
    async request() {
      throw new Error('no routines are installed in this test')
    },
  }
}

/** A Work whose PR went green and merged inside one downtime (§5.1, §5.2). */
const mergedWhileDown = (): readonly AppendEvent[] => {
  const id = 'wrk_0000000000000009' as WorkId
  const repo = 'acme/widgets' as Repo
  const pr = { repo, number: 9 }
  const headSha = 'b'.repeat(40) as Sha
  const ts = '2026-11-10T09:00:00.000Z'
  return [
    { ts, type: 'work.proposed', subject: id, actor: 'user', data: { workId: id, title: 'merged while nobody watched', dependsOn: [] } },
    { ts, type: 'work.ready', subject: id, actor: 'scheduler', data: { workId: id } },
    { ts, type: 'work.assigned', subject: id, actor: 'pm', data: { workId: id, peerId: 'engineer-1' as PeerId, briefId: 'brf_0000000000000009' as BriefId, briefVersion: 1 } },
    { ts, type: 'pr.opened', subject: `${repo}#9`, actor: 'scheduler', data: { pr, base: 'main', head: `work/${id}`, headSha, workId: id } },
    { ts, type: 'pr.checks_changed', subject: `${repo}#9`, actor: 'scheduler', data: { pr, headSha, state: 'passing', failing: [] } },
    { ts, type: 'pr.review_changed', subject: `${repo}#9`, actor: 'scheduler', data: { pr, headSha, state: 'approved' } },
    { ts, type: 'pr.merged', subject: `${repo}#9`, actor: 'scheduler', data: { pr, headSha } },
  ]
}

/** A message that was sent before the daemon started and is already acknowledged: history, not a pending box. */
const ackedWhileDown = (): readonly AppendEvent[] => {
  const msgId = 'msg_0000000000000001' as MessageId
  const ts = '2026-11-10T09:00:00.000Z'
  const to = 'engineer-1' as PeerId
  return [
    { ts, type: 'message.sent', subject: msgId, actor: 'pm', data: { msgId, to, from: 'pm', kind: 'info', briefVersion: 1, body: 'already answered' } },
    { ts, type: 'message.acked', subject: msgId, actor: 'peer:engineer-1', data: { msgId, to } },
  ]
}

const harness = async (
  options: {
    readonly reachable?: boolean
    /** Events that landed while fleetd was down, written before the daemon exists. */
    readonly seed?: readonly AppendEvent[]
    /** Every write the daemon makes, in the order the scheduler's own calls allow it. */
    readonly order?: string[]
    /** The profile `fleet up` reads, when a test's answer is in the profile itself (TASK-12). */
    readonly profile?: Profile
    /** What the providers `compose.ts` would have built can do. */
    readonly providerCapabilities?: (provider: string) => { readonly effort: boolean } | undefined
    /** The shared fleet's loop, when the profile is in an engagement (shared-fleet.md §2.2). */
    readonly coordination?: { start(): void; stop(): void }
  } = {},
) => {
  const declared = options.profile ?? profile()
  const paths = pathsFor()
  for (const dir of persistentDirs(paths)) await mkdir(dir, { recursive: true })
  const store: EventStore = await openSqliteStore({ path: paths.storePath })
  await store.migrate()
  if (options.seed !== undefined && options.seed.length > 0) await store.append(options.seed)
  const supervisor = fakeSupervisor(options)
  const scheduler = fakeScheduler(options.order)
  // The daemon writes through this, the way `compose.ts` hands it the waking sink:
  // what it records is what the daemon actually appended, and when.
  const append = (batch: readonly AppendEvent[]): Promise<readonly Seq[]> => {
    for (const event of batch) options.order?.push(event.type)
    return store.append(batch)
  }
  const mailbox = createMailbox({
    store: { append: (batch) => store.append(batch), messages: store.reader().messages },
    sessions: supervisor,
    briefs: supervisor.briefs,
  })
  // A real ledger over the real store, with the process faked: this suite is
  // about what the API writes, and a build that actually spawned `pnpm` would
  // be testing the machine it runs on.
  const ledger = createDaemonBuilds({
    profile: declared,
    sink: { append: (batch) => store.append(batch) },
    builds: store.reader().builds,
    logDir: join(paths.artifactsDir, 'builds'),
    process: async () => ({ code: 0, durationMs: 1 }),
  })
  const daemon = createDaemon({
    profile: declared,
    paths,
    store,
    append,
    supervisor,
    mailbox,
    scheduler,
    ledger,
    pid: 99,
    ...(options.providerCapabilities === undefined
      ? {}
      : { providerCapabilities: options.providerCapabilities }),
    ...(options.coordination === undefined ? {} : { coordination: options.coordination }),
  })
  return { daemon, store, supervisor, scheduler, paths }
}

test('up registers every declared peer once, and again does nothing', async () => {
  const { daemon, store } = await harness()

  await daemon.up()
  const first = await store.read(1)
  assert.equal(first.filter((event) => event.type === 'peer.registered').length, 2)

  await daemon.up()
  const after = await store.read(1)
  assert.equal(after.filter((event) => event.type === 'peer.registered').length, 2, 'up is idempotent')

  const peers = await store.reader().peers.all()
  assert.deepEqual(peers.map((peer) => peer.peerId).sort(), ['architect', 'engineer-1'])
  await daemon.down()
})

test('up starts the supervisor before the scheduler, and down stops them the other way round', async () => {
  const { daemon, supervisor, scheduler } = await harness()

  await daemon.up()
  assert.deepEqual(supervisor.log, ['supervisor.start'])
  assert.deepEqual(scheduler.log, ['scheduler.start'])

  await daemon.down()
  assert.deepEqual(scheduler.log, ['scheduler.start', 'scheduler.stop'])
  assert.deepEqual(supervisor.log, ['supervisor.start', 'supervisor.stop'])
  assert.equal(daemon.running, false)
})

test('a second down after up stops the sessions the second up started', async () => {
  const { daemon, supervisor, scheduler } = await harness()

  await daemon.up()
  await daemon.down()
  await daemon.up()
  await daemon.down()

  assert.deepEqual(
    supervisor.log,
    ['supervisor.start', 'supervisor.stop', 'supervisor.start', 'supervisor.stop'],
    'the second down must stop the peers the second up started, not return the first stop again',
  )
  assert.deepEqual(scheduler.log, ['scheduler.start', 'scheduler.stop', 'scheduler.start', 'scheduler.stop'])
  assert.equal(daemon.running, false)
})

test('two up calls in flight start the supervisor and the scheduler once', async () => {
  const { daemon, supervisor, scheduler } = await harness()

  const [first, second] = await Promise.all([daemon.up(), daemon.up()])
  assert.deepEqual(supervisor.log, ['supervisor.start'], 'a second `up` while the first is starting must not start peers again')
  assert.deepEqual(scheduler.log, ['scheduler.start'])
  assert.deepEqual(second, first)
  await daemon.down()
})

test('up catches up a Work whose PR merged while fleetd was down, after the scheduler starts', async () => {
  const order: string[] = []
  const { daemon, store } = await harness({ seed: mergedWhileDown(), order })
  const workId = 'wrk_0000000000000009' as WorkId
  assert.equal((await store.reader().work.get(workId))?.state, 'assigned', 'nobody translated the PR onto the Work')

  await daemon.up()

  assert.equal((await store.reader().work.get(workId))?.state, 'merged')
  // The ordering is the point: the waking sink's scheduler is late-bound, so a write
  // made before `scheduler.start()` would be committed and never woken (`wake.ts`).
  assert.ok(
    order.indexOf('scheduler.start') < order.indexOf('work.merged'),
    `the catch-up is written after the scheduler is up, not before: ${order.join(', ')}`,
  )
  await daemon.down()
})

test('a second up after the catch-up writes no second work.merged', async () => {
  const { daemon, store } = await harness({ seed: mergedWhileDown() })
  await daemon.up()
  await daemon.down()

  await daemon.up()

  const all = (await store.read(0, 10_000)).map((event) => event.type)
  assert.equal(all.filter((type) => type === 'work.merged').length, 1, 'the restart found the Work caught up')
  await daemon.down()
})

test('ls reports the profile peers with the state the store knows', async () => {
  const { daemon, store } = await harness()
  await daemon.up()

  const { status, peers } = await daemon.ls()
  assert.equal(status.pid, 99)
  assert.equal(status.profile, 'test')
  // The projection orders by registration, which is the order `up` wrote them,
  // and it is the §3 row itself — not a flattened copy of it.
  assert.deepEqual(peers.map((peer) => peer.peerId).sort(), ['architect', 'engineer-1'])
  assert.equal(peers.find((peer) => peer.peerId === 'engineer-1')?.role, 'engineer')
  await daemon.down()
  assert.equal((await store.latestSeq()) > 0, true)
})

test('work reports every Work item in the state the projection holds, unfiltered', async () => {
  const { daemon, store } = await harness()
  await daemon.up()

  const STACKED = 'wrk_7f3a91c2d84b0e56' as WorkId
  const BOARD = 'wrk_2b3c4d5e6f708192' as WorkId
  const proposed = (workId: WorkId, title: string): AppendEvent => ({
    ts: '2026-11-10T09:00:00.000Z',
    type: 'work.proposed',
    subject: workId,
    actor: 'user',
    causedBy: [],
    data: { workId, title, role: 'engineer', dependsOn: [] },
  })
  await store.append([
    proposed(STACKED, 'Retarget stacked PRs before merging'),
    proposed(BOARD, 'Say which phase the board is in'),
  ])
  await store.append([
    {
      ts: '2026-11-10T09:01:00.000Z',
      type: 'work.ready',
      subject: BOARD,
      actor: 'pm',
      causedBy: [],
      data: { workId: BOARD, reason: 'nothing to wait for' },
    },
  ])

  const { work } = await daemon.work()
  // The projection's order is `created_at, work_id`; both were proposed at the same
  // instant, so the id breaks the tie. The daemon adds no ordering of its own.
  assert.deepEqual(
    work.map((item) => [item.workId, item.state]),
    [
      ['wrk_2b3c4d5e6f708192', 'ready'],
      ['wrk_7f3a91c2d84b0e56', 'proposed'],
    ],
    'the rows are the projection rows, in its order, each in its own state',
  )
  assert.equal(work[0]?.title, 'Say which phase the board is in')
  await daemon.down()
})

test('send writes the message through the Mailbox, hands it to the peer, and peek reads it back', async () => {
  const { daemon, store, supervisor } = await harness()
  await daemon.up()

  const { msgId } = await daemon.send({ to: 'engineer-1' as PeerId, kind: 'info', body: 'take #12' })
  assert.match(msgId, /^msg_[0-9a-f]{16}$/)

  const events = await store.read(1)
  const sent = events.find((event) => event.type === 'message.sent')
  assert.equal(sent === undefined ? '' : sent.actor, 'user')
  assert.equal(
    sent?.type === 'message.sent' ? sent.data.briefVersion : -1,
    2,
    'the brief version comes from the supervisor, not from the caller',
  )

  // §7: the send goes through the Mailbox *and* delivers — the peer's session
  // is handed the turn in the same call, so `fleet send` does not just queue.
  assert.deepEqual(supervisor.sent, ['take #12'])
  const delivered = events.find((event) => event.type === 'message.delivered')
  assert.equal(delivered?.type === 'message.delivered' ? delivered.data.msgId : '', msgId)

  const { messages } = await daemon.peek({ peer: 'engineer-1' as PeerId })
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.body, 'take #12')
  await daemon.down()
})

test('peek refuses a peer this fleet does not have, rather than calling it an empty mailbox', async () => {
  const { daemon } = await harness()
  await daemon.up()
  // "no messages" for a name that is not a peer is a typo read as an answer.
  await assert.rejects(
    () => daemon.peek({ peer: 'nobdoy' as PeerId }),
    (error: unknown) => error instanceof FleetError && error.code === 'not_found' && /no peer nobdoy/.test(error.message),
  )
  await daemon.down()
})

test('peek with limit 0 returns nothing, rather than the whole pending box', async () => {
  // `count()` allows 0, and `slice(-0)` is `slice(0)` — the whole box. A limit of
  // zero asks for nothing, and "nothing" is an empty list, not everything there is.
  const { daemon } = await harness({ reachable: false })
  await daemon.up()
  await daemon.send({ to: 'engineer-1' as PeerId, kind: 'info', body: 'take #14' })

  const none = await daemon.peek({ peer: 'engineer-1' as PeerId, limit: 0 })
  assert.deepEqual(none.messages, [], 'limit 0 is an empty answer, not the pending box')

  // The same call with a limit still means "the last n" — the fix narrows 0, nothing else.
  const one = await daemon.peek({ peer: 'engineer-1' as PeerId, limit: 1 })
  assert.deepEqual(one.messages.map((message) => message.body), ['take #14'])
  await daemon.down()
})

test('peek with limit 0 returns nothing from the history fallback either', async () => {
  // The box is empty, so `peek` reads the projection instead; that slice is the
  // second place `-0` would have turned "nothing" into "everything".
  const { daemon } = await harness({ seed: ackedWhileDown() })
  await daemon.up()

  const { messages } = await daemon.peek({ peer: 'engineer-1' as PeerId, limit: 0 })
  assert.deepEqual(messages, [])
  await daemon.down()
})

test('a send that names its sender is recorded as that peer, and an unknown sender is refused (§8)', async () => {
  const { daemon, store } = await harness()
  await daemon.up()

  await daemon.send({ to: 'engineer-1' as PeerId, kind: 'info', body: 'from the architect', from: 'architect' as PeerId })
  const sent = (await store.read(1)).filter((event) => event.type === 'message.sent')
  assert.equal(sent.at(-1)?.actor, 'peer:architect')
  assert.equal(sent.at(-1)?.type === 'message.sent' ? sent.at(-1)?.data.from : undefined, 'peer:architect')

  await assert.rejects(
    daemon.send({ to: 'engineer-1' as PeerId, kind: 'info', body: 'hi', from: 'ghost' as PeerId }),
    (error: FleetError) => error.code === 'not_found' && /ghost/.test(error.message),
  )
  await daemon.down()
})

test('a send to a registered peer with no session queues, and stays pending until one is there', async () => {
  // The queue rule: an unanswered session is not an error the sender must fix —
  // the message waits in the box and the Mailbox replays it on resume (§7).
  const { daemon, store, supervisor } = await harness({ reachable: false })
  await daemon.up()

  const { msgId } = await daemon.send({ to: 'engineer-1' as PeerId, kind: 'info', body: 'take #13' })
  assert.match(msgId, /^msg_[0-9a-f]{16}$/)
  assert.deepEqual(supervisor.sent, [], 'there was no session to hand it to')

  const events = await store.read(1)
  assert.equal(
    events.some((event) => event.type === 'message.delivered'),
    false,
    'nothing was delivered, so no delivery is recorded',
  )
  const pending = await daemon.peek({ peer: 'engineer-1' as PeerId })
  assert.deepEqual(pending.messages.map((message) => message.body), ['take #13'])
  assert.equal(pending.messages[0]?.state, 'pending')

  // The session comes up, and the same message is delivered — once.
  supervisor.online(true)
  await daemon.send({ to: 'engineer-1' as PeerId, kind: 'info', body: 'take #14' })
  assert.deepEqual(supervisor.sent, ['take #13', 'take #14'], 'the queued message goes first')
  await daemon.down()
})

test('a send to a peer the fleet does not know is not_found', async () => {
  const { daemon } = await harness()
  await daemon.up()
  await assert.rejects(
    daemon.send({ to: 'ghost' as PeerId, kind: 'info', body: 'hello' }),
    (thrown: unknown) => {
      assert.equal((thrown as { code?: string }).code, 'not_found')
      return true
    },
  )
  await daemon.down()
})

test('usage records a peer\'s turn as turn.usage_recorded, and refuses a peer the fleet does not know', async () => {
  const { daemon, store } = await harness()
  await daemon.up()
  const report = {
    peerId: 'engineer-1' as PeerId,
    contextTokens: 1200,
    contextLimit: 200_000,
    inputTokens: 900,
    outputTokens: 300,
    cachedTokens: 800,
    toolCalls: { grep: 1, glob: 0, read: 2, codegraph: 3 },
  }
  assert.deepEqual(await daemon.usage(report), { recorded: true })

  const recorded = (await store.read(1)).filter((event) => event.type === 'turn.usage_recorded')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]?.subject, 'engineer-1')
  assert.equal(recorded[0]?.actor, 'peer:engineer-1')

  await assert.rejects(() => daemon.usage({ ...report, peerId: 'ghost' as PeerId }), /no peer/)
  await daemon.down()
})

test('a note lands on the Work the peer holds, and the reply names the Work the peer did not', async () => {
  const { daemon, store } = await harness()
  await daemon.up()

  const WORK = 'wrk_7f3a91c2d84b0e56' as WorkId
  await store.append([
    { ts: '2026-11-10T09:00:00.000Z', type: 'work.proposed', subject: WORK, actor: 'user', causedBy: [], data: { workId: WORK, title: 'Say which phase the board is in', dependsOn: [] } },
    { ts: '2026-11-10T09:01:00.000Z', type: 'work.assigned', subject: WORK, actor: 'pm', causedBy: [], data: { workId: WORK, peerId: 'engineer-1' as PeerId, briefId: 'brf_0123456789abcdef' as BriefId, briefVersion: 1 } },
  ])

  // §5.1: the peer names the phase and the words; the Work is the daemon's answer.
  assert.deepEqual(await daemon.note({ peerId: 'engineer-1' as PeerId, phase: 'blocked', body: 'no way to replay a partial log' }), {
    workId: WORK,
    phase: 'blocked',
  })

  const noted = (await store.read(1)).filter((event) => event.type === 'work.noted')
  assert.equal(noted.length, 1)
  assert.equal(noted[0]?.subject, WORK)
  assert.equal(noted[0]?.actor, 'peer:engineer-1')
  assert.deepEqual(noted[0]?.data, {
    workId: WORK,
    peerId: 'engineer-1',
    phase: 'blocked',
    body: 'no way to replay a partial log',
  })

  // A peer with nothing assigned has nothing to note on, and one that the fleet does
  // not have is not a peer: the same code, because neither names a Work.
  await assert.rejects(
    () => daemon.note({ peerId: 'architect-1' as PeerId, phase: 'plan', body: 'reading the design' }),
    (thrown: unknown) => {
      assert.equal((thrown as { code?: string }).code, 'not_found')
      return true
    },
  )
  await daemon.down()
})

test('a peer holding two live Works is a conflict, not a guess about which one it meant', async () => {
  const { daemon, store } = await harness()
  await daemon.up()

  const A = 'wrk_7f3a91c2d84b0e56' as WorkId
  const B = 'wrk_2b3c4d5e6f708192' as WorkId
  const assigned = (workId: WorkId, ts: string): AppendEvent[] => [
    { ts, type: 'work.proposed', subject: workId, actor: 'user', causedBy: [], data: { workId, title: 'x', dependsOn: [] } },
    { ts, type: 'work.assigned', subject: workId, actor: 'pm', causedBy: [], data: { workId, peerId: 'engineer-1' as PeerId, briefId: 'brf_0123456789abcdef' as BriefId, briefVersion: 1 } },
  ]
  await store.append([...assigned(A, '2026-11-10T09:00:00.000Z'), ...assigned(B, '2026-11-10T09:02:00.000Z')])

  await assert.rejects(
    () => daemon.note({ peerId: 'engineer-1' as PeerId, phase: 'implement', body: 'x' }),
    (thrown: unknown) => {
      assert.equal((thrown as { code?: string }).code, 'conflict')
      assert.match((thrown as Error).message, /holds 2 Works/)
      return true
    },
  )
  await daemon.down()
})

test('decide answers an open decision and refuses one that is not there', async () => {
  const { daemon, store } = await harness()
  await daemon.up()

  const decisionId = newDecisionId()
  await store.append([
    {
      type: 'decision.requested',
      ts: '2026-11-10T10:00:00.000Z',
      subject: decisionId,
      actor: 'pm',
      data: {
        decisionId,
        kind: 'merge_pr',
        question: 'merge #42?',
        options: ['yes', 'no'],
        inputsHash: 'abcdef12',
      },
    },
  ])

  const row = await daemon.decide({ id: decisionId, decision: 'yes' })
  assert.equal(row.decisionId, decisionId)
  assert.deepEqual(row.options, ['yes', 'no'])

  const answered = (await store.read(1)).filter((event) => event.type === 'decision.answered')
  assert.equal(answered.length, 1)
  assert.equal(answered[0]?.type === 'decision.answered' ? answered[0].data.source : '', 'user')
  assert.equal(answered[0]?.type === 'decision.answered' ? answered[0].data.option : '', 'yes')

  await assert.rejects(() => daemon.decide({ id: newDecisionId(), decision: 'yes' }), /no decision/)
  await assert.rejects(
    () => daemon.decide({ id: decisionId, decision: 'yes' }),
    /not open/,
    'an answered decision stays answered',
  )
  await daemon.down()
})

test('decide refuses an answer the decision does not offer', async () => {
  const { daemon, store } = await harness()
  await daemon.up()

  const decisionId: DecisionId = newDecisionId()
  await store.append([
    {
      type: 'decision.requested',
      ts: '2026-11-10T10:00:00.000Z',
      subject: decisionId,
      actor: 'pm',
      data: { decisionId, kind: 'merge_pr', question: 'merge?', options: ['yes', 'no'], inputsHash: 'abcdef12' },
    },
  ])

  await assert.rejects(() => daemon.decide({ id: decisionId, decision: 'maybe' }), /is not one of them/)
  await daemon.down()
})

/**
 * §5.4. A rebuild is judged by what survives it: the projections are dropped
 * and derived again from the log, so the rows before and after must be the
 * same rows, and the answer must be the log's own numbers rather than a count
 * the daemon kept.
 */
test('replay rebuilds every projection from the log and answers with what it replayed', async () => {
  const { daemon, store } = await harness()
  await daemon.up()
  const before = await store.reader().peers.all()

  const rebuilt = await daemon.replay({})
  assert.equal(rebuilt.mode, 'rebuild')
  if (rebuilt.mode !== 'rebuild') return

  const health = await store.health()
  assert.equal(rebuilt.events, health.events)
  assert.equal(rebuilt.latestSeq, health.latestSeq)
  // The peers came back from the events, not from a table that was left in place.
  assert.deepEqual(await store.reader().peers.all(), before)
  await daemon.down()
})

test('replay with a `from` reads that window of the log and writes nothing', async () => {
  const { daemon, store } = await harness()
  await daemon.up()
  const latest = await store.latestSeq()

  const window = await daemon.replay({ from: 1, to: latest })
  assert.equal(window.mode, 'window')
  if (window.mode !== 'window') return
  // Every event in [1, latest], oldest first, and exactly the rows the log holds.
  assert.deepEqual(window.events.map((event) => event.seq), Array.from({ length: latest }, (_, index) => index + 1))
  assert.deepEqual(window.events, await store.read(1))
  assert.equal(await store.latestSeq(), latest, 'a read does not move the log')
  await daemon.down()
})

test('replay refuses a `to` with no `from` rather than reading it as a rebuild', async () => {
  const { daemon } = await harness()
  // The dangerous reading: `--to` alone would match "no from" and rebuild the
  // whole store, which is a much bigger thing than the window someone meant.
  await assert.rejects(
    () => daemon.replay({ to: 5 }),
    (thrown: unknown) => thrown instanceof FleetError && thrown.code === 'invalid_input',
  )
})

/**
 * TASK-12: a profile may ask for a reasoning level, and a provider that cannot
 * honour one must not let the fleet look as if it had.
 *
 * The warning is on the status `fleet up` prints, not on the store: it is about
 * this machine's providers, which is a fact about the daemon and not about the
 * fleet's work, and a stored event would outlive the provider that caused it.
 */
test('up warns, naming the peer, when the profile asks for an effort the provider cannot honour', async () => {
  const asked: Profile = {
    profile: 'test',
    repos: [],
    roles: { reviewer: { effort: 'high' } },
    peers: [
      // The role supplies the effort; cursor cannot honour it.
      { id: 'reviewer-1' as PeerId, role: 'reviewer', provider: 'cursor', model: 'gpt-5.2' },
      // The same effort on claude, which can: no warning, because there is
      // nothing to warn about.
      { id: 'engineer-1' as PeerId, role: 'engineer', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    ],
  }
  const { daemon } = await harness({
    profile: asked,
    providerCapabilities: (provider) => (provider === 'cursor' ? { effort: false } : { effort: true }),
  })
  await daemon.up()

  assert.deepEqual(daemon.status.warnings, [
    "peer 'reviewer-1' asks for effort 'high', but provider 'cursor' cannot honour it: the session starts at that provider's own default",
  ])
  await daemon.down()
})

test('a fleet that asked for no effort carries no warnings, even on a provider that could not honour one', async () => {
  const { daemon } = await harness({ providerCapabilities: () => ({ effort: false }) })
  await daemon.up()
  // Absent on the status rather than an empty list: `fleet up` prints warnings
  // it has, and a field that is always there invites a reader to think it means
  // something when it is empty.
  assert.equal(daemon.status.warnings, undefined)
  await daemon.down()
})

test('a shared fleet starts publishing once it is up, and stops before the scheduler on down', async () => {
  const order: string[] = []
  const coordination = {
    start: () => {
      order.push('coordination.start')
    },
    stop: () => {
      order.push('coordination.stop')
    },
  }
  const { daemon } = await harness({ order, coordination })

  await daemon.up()
  assert.ok(
    order.indexOf('scheduler.start') < order.indexOf('coordination.start'),
    `the pool hears from a fleet that is up, not one coming up: ${order.join(', ')}`,
  )

  await daemon.down()
  assert.ok(
    order.indexOf('coordination.stop') < order.indexOf('scheduler.stop'),
    `a fleet going down stops telling the pool its peers are idle first: ${order.join(', ')}`,
  )
})
