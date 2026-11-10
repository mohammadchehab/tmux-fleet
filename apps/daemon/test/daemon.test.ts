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
  newDecisionId,
  ok,
  type DecisionId,
  type PeerId,
  type SessionId,
  type TurnId,
} from '@fleet/foundation-core'
import type { PeerSessionLease, Turn } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore } from '@fleet/foundation-store'
import { createMailbox } from '@fleet/runtime-mailbox'
import type { Scheduler } from '@fleet/orchestration-routines'

import { createDaemon } from '../src/daemon.ts'
import type { Supervisor } from '../src/sessions.ts'
import { persistentDirs, profilePaths } from '../src/paths.ts'
import type { Profile } from '../src/profile.ts'

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

const fakeSupervisor = (): Supervisor & { readonly log: readonly string[]; readonly sent: readonly string[] } => {
  const log: string[] = []
  const sent: string[] = []
  return {
    log,
    sent,
    async start() {
      log.push('supervisor.start')
    },
    async stop() {
      log.push('supervisor.stop')
    },
    async acquire(peer: PeerId) {
      const lease: PeerSessionLease = {
        sessionId: `ses_${String(peer)}` as SessionId,
        resumed: false,
        async send(turn: Turn): Promise<TurnId> {
          sent.push(turn.text)
          return `trn_${String(sent.length)}` as TurnId
        },
      }
      return ok(lease)
    },
    briefs: {
      async current() {
        return 2
      },
    },
    running() {
      return [] as readonly PeerId[]
    },
  }
}

const fakeScheduler = (): Scheduler & { readonly log: readonly string[] } => {
  const log: string[] = []
  return {
    log,
    plan: { routines: [], installed: [], unimplemented: [] },
    async start() {
      log.push('scheduler.start')
      return []
    },
    stop() {
      log.push('scheduler.stop')
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

const harness = async () => {
  const paths = pathsFor()
  for (const dir of persistentDirs(paths)) await mkdir(dir, { recursive: true })
  const store: EventStore = await openSqliteStore({ path: paths.storePath })
  await store.migrate()
  const supervisor = fakeSupervisor()
  const scheduler = fakeScheduler()
  const mailbox = createMailbox({
    store: { append: (batch) => store.append(batch), messages: store.reader().messages },
    sessions: supervisor,
    briefs: supervisor.briefs,
  })
  const daemon = createDaemon({ profile: profile(), paths, store, supervisor, mailbox, scheduler, pid: 99 })
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

test('ls reports the profile peers with the state the store knows', async () => {
  const { daemon, store } = await harness()
  await daemon.up()

  const { status, peers } = await daemon.ls()
  assert.equal(status.pid, 99)
  assert.equal(status.profile, 'test')
  // The projection orders by registration, which is the order `up` wrote them.
  assert.deepEqual(peers.map((peer) => peer.id).sort(), ['architect', 'engineer-1'])
  assert.equal(peers.find((peer) => peer.id === 'engineer-1')?.role, 'engineer')
  await daemon.down()
  assert.equal((await store.latestSeq()) > 0, true)
})

test('send writes the message through the Mailbox and peek reads it back', async () => {
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

  const { messages } = await daemon.peek({ peer: 'engineer-1' as PeerId })
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.body, 'take #12')
  assert.equal(supervisor.sent.length, 0, 'send does not deliver; the Mailbox does (§7)')
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
  assert.equal(row.id, decisionId)
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
