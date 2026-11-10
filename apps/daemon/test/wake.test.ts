/**
 * Append → wake (§2, §5.2), over the real SQLite store.
 *
 * The store is the real one, because the whole claim here is about *when* a
 * wake happens relative to a commit — a fake that "appends" by pushing onto an
 * array would pass a test in which the wake ran before the transaction. The
 * scheduler and the supervisor are fakes: they start timers and processes, and
 * what this file judges is the order the daemon calls them in.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  newSessionId,
  ok,
  type Actor,
  type PeerId,
  type ProviderSessionRef,
  type SessionId,
  type TurnId,
} from '@fleet/foundation-core'
import type { AppendEvent, FleetEvent, PeerSessionLease, Turn } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore } from '@fleet/foundation-store'
import { createMailbox } from '@fleet/runtime-mailbox'

import type { Supervisor } from '../src/sessions.ts'
import { createWakingSink, deliverOnSessionStart, type WakingSinkDeps } from '../src/wake.ts'

const roots = await mkdtemp(join(tmpdir(), 'fleet-wake-'))
after(async () => {
  await rm(roots, { recursive: true, force: true })
})

let counter = 0
const openStore = async (): Promise<EventStore> => {
  const store = await openSqliteStore({ path: join(roots, `store-${(counter += 1)}.sqlite`) })
  await store.migrate()
  return store
}

const peer = 'engineer-1' as PeerId

const registered = (): AppendEvent => ({
  ts: '2026-11-10T09:01:00.000Z',
  type: 'peer.registered',
  subject: peer,
  actor: 'pm',
  data: { peerId: peer, role: 'engineer', providerId: 'claude-code', model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits' },
})

const started = (sessionId: SessionId, resumed = false): AppendEvent => ({
  ts: '2026-11-10T09:04:00.000Z',
  type: 'session.started',
  subject: peer,
  actor: 'pm',
  data: {
    peerId: peer,
    sessionId,
    providerId: 'claude-code',
    providerSessionRef: `sess_${sessionId}` as ProviderSessionRef,
    model: 'claude-sonnet-5-5',
    permissionMode: 'acceptEdits',
    resumed,
  },
})

/** The sink over `store`, with `scheduler` and `onError` supplied by the test. */
const sinkOver = (store: EventStore, deps: Partial<WakingSinkDeps> = {}) =>
  createWakingSink({
    append: (batch) => store.append(batch),
    read: (from, limit) => store.read(from, limit),
    scheduler: () => undefined,
    ...deps,
  })

test('every committed event wakes once, in seq order, after the commit', async () => {
  const store = await openStore()
  const wakes: FleetEvent[] = []
  const readableWhenWoken: number[] = []

  const sink = sinkOver(store, {
    scheduler: () => ({
      async wake(event) {
        wakes.push(event)
        // The one assertion the whole slice rests on: by the time a routine
        // hears about an event, it is in the log for every other reader too.
        readableWhenWoken.push((await store.read(event.seq, 1)).length)
        return []
      },
    }),
  })

  const seqs = await sink.append([registered(), started(newSessionId()), started(newSessionId())])

  assert.deepEqual(seqs, [1, 2, 3])
  assert.deepEqual(wakes.map((event) => event.seq), [1, 2, 3], 'once per event, in the order the store assigned')
  assert.deepEqual(wakes.map((event) => event.type), ['peer.registered', 'session.started', 'session.started'])
  assert.deepEqual(readableWhenWoken, [1, 1, 1], 'each event is durable before anything wakes on it')
})

test('an empty batch wakes nothing', async () => {
  const store = await openStore()
  const wakes: FleetEvent[] = []
  const sink = sinkOver(store, { scheduler: () => ({ async wake(event) { wakes.push(event); return [] } }) })

  assert.deepEqual(await sink.append([]), [])
  assert.deepEqual(wakes, [])
})

test('a wake that throws is reported, and the append still resolves with its seqs', async () => {
  const store = await openStore()
  const failures: { error: unknown; seq: number }[] = []

  const sink = sinkOver(store, {
    scheduler: () => ({
      async wake() {
        throw new Error('routine blew up')
      },
    }),
    onError: (error, event) => failures.push({ error, seq: event.seq }),
  })

  // Not a rejection: the events are committed and durable, and telling the
  // caller its write failed would invite a second append of the same events.
  assert.deepEqual(await sink.append([registered(), started(newSessionId())]), [1, 2])
  assert.deepEqual(failures.map((failure) => failure.seq), [1, 2])
  assert.equal((await store.read(1)).length, 2, 'both events are in the log')
})

test('listeners hear every event after the scheduler, in the order they registered', async () => {
  const store = await openStore()
  const log: string[] = []
  const sink = sinkOver(store, { scheduler: () => ({ async wake() { log.push('wake'); return [] } }) })

  sink.listen(async () => {
    log.push('first')
  })
  sink.listen(async () => {
    log.push('second')
  })

  await sink.append([registered()])
  assert.deepEqual(log, ['wake', 'first', 'second'])
})

test('a listener that throws does not stop the next one, or fail the append', async () => {
  const store = await openStore()
  const log: string[] = []
  const failures: number[] = []
  const sink = sinkOver(store, {
    scheduler: () => ({ async wake() { return [] } }),
    onError: (_error, event) => failures.push(event.seq),
  })

  sink.listen(async () => {
    throw new Error('delivery failed')
  })
  sink.listen(async () => {
    log.push('second')
  })

  assert.deepEqual(await sink.append([registered()]), [1])
  assert.deepEqual(log, ['second'], 'the listener after the failing one still runs')
  assert.deepEqual(failures, [1])
})

test('an append before the scheduler exists is committed and not woken', async () => {
  const store = await openStore()
  const sink = sinkOver(store)
  const heard: FleetEvent[] = []
  sink.listen(async (event) => {
    heard.push(event)
  })

  assert.deepEqual(await sink.append([registered()]), [1])
  assert.equal((await store.read(1)).length, 1, 'the write still happened')
  assert.deepEqual(heard, [], 'a stopped daemon commits without running routines')
})

// ------------------------------------------------------------------- delivery

const fakeSupervisor = (sessionId: SessionId): Supervisor & { readonly sent: readonly string[] } => {
  const sent: string[] = []
  return {
    sent,
    async start() {},
    async stop() {},
    async acquire() {
      const lease: PeerSessionLease = {
        sessionId,
        resumed: true,
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

test('a pending message is delivered when its peer reaches running, and a replay does not duplicate it', async () => {
  const store = await openStore()
  const sessionId = newSessionId()
  const supervisor = fakeSupervisor(sessionId)
  const sink = sinkOver(store, { scheduler: () => ({ async wake() { return [] } }) })
  const mailbox = createMailbox({
    store: { append: (batch) => sink.append(batch), messages: store.reader().messages },
    sessions: supervisor,
    briefs: supervisor.briefs,
  })

  // Exactly the wiring `compose` uses: `session.started` is the moment a peer can
  // be handed something, because it is the moment it has a session to hand it to.
  sink.listen(deliverOnSessionStart(mailbox))

  await sink.append([registered()])

  const sent = await mailbox.send({
    to: peer,
    from: 'pm' as Actor,
    kind: 'nudge',
    briefVersion: 2,
    body: 'CI is red on integration/postgres.',
  })
  assert.ok(sent.ok)
  assert.deepEqual(supervisor.sent, [], 'send writes the message; the Mailbox delivers it (§7)')

  await sink.append([started(sessionId)])
  assert.deepEqual(supervisor.sent, ['CI is red on integration/postgres.'], 'the message follows the session')

  const deliveries = async () => (await store.read(1)).filter((event) => event.type === 'message.delivered')
  assert.equal((await deliveries()).length, 1)

  // A replay rebuilds every projection from the log alone. The acknowledgement is
  // in the log, so it survives — that is what makes at-least-once safe across a
  // restart rather than only within one process.
  await store.rebuild()
  const messages = await store.reader().messages.forPeer(peer)
  assert.equal(messages.find((message) => message.body === 'CI is red on integration/postgres.')?.state, 'delivered')

  // The same session resumes: at-least-once says try again, and the session that
  // already has the message says do not put a second copy in front of the peer.
  await sink.append([started(sessionId, true)])
  assert.deepEqual(supervisor.sent, ['CI is red on integration/postgres.'], 'no second turn in the same session')
  assert.equal((await deliveries()).length, 1, 'and no second acknowledgement in the log')
})

/**
 * §7 resume: the lease a delivery asks for can be created by *starting* a session,
 * and that start appends `session.started` inside the delivery that asked for it.
 * The append wakes the listener again, for the same peer, from inside the first
 * delivery — the one shape that can deadlock the Mailbox's per-peer serialization,
 * because the second delivery would wait for the first to finish.
 */
test('a resume that starts the session inside the delivery does not re-enter it', { timeout: 5000 }, async () => {
  const store = await openStore()
  const sessionId = newSessionId()
  const sent: string[] = []
  const sink = sinkOver(store, { scheduler: () => ({ async wake() { return [] } }) })

  const sessions = {
    async acquire() {
      // A resuming `acquire`: the session that makes the lease exists only now, and
      // its `session.started` is appended through the same sink as every other write.
      await sink.append([started(sessionId, true)])
      return ok({
        sessionId,
        resumed: true,
        async send(turn: Turn): Promise<TurnId> {
          sent.push(turn.text)
          return `trn_${String(sent.length)}` as TurnId
        },
      })
    },
  }

  const mailbox = createMailbox({
    store: { append: (batch) => sink.append(batch), messages: store.reader().messages },
    sessions,
    briefs: { async current() { return 2 } },
  })
  sink.listen(deliverOnSessionStart(mailbox))

  await sink.append([registered()])
  await mailbox.send({ to: peer, from: 'pm' as Actor, kind: 'nudge', briefVersion: 2, body: 'CI is red.' })

  // Reaching this line at all is the assertion: without the guard this append never
  // resolves, because the delivery it wakes waits for the delivery it is inside.
  await sink.append([started(sessionId)])

  assert.deepEqual(sent, ['CI is red.'], 'the message is handed over once')
  const deliveries = (await store.read(1)).filter((event) => event.type === 'message.delivered')
  assert.equal(deliveries.length, 1, 'and acknowledged once')
})
