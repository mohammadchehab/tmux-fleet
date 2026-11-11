/**
 * One peer held for a person, or stopped, and given back — through the
 * supervisor, against a real store (watch-and-attach §4, §7.2, §12).
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { profilePaths, systemClock, type PeerId, type ProviderSessionRef, type TurnId } from '@fleet/foundation-core'
import type { AppendEvent, FleetEvent, ProviderEvent, SessionSpec, Turn } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore } from '@fleet/foundation-store'
import { createMailbox } from '@fleet/runtime-mailbox'
import type { Provider, SessionHandle } from '@fleet/runtime-provider-sdk'

import { decodeProfile } from '../src/config/profile.ts'
import { createSupervisor, handbackNote, type Supervisor } from '../src/execution/sessions.ts'
import { createWakingSink, deliverOnSessionStart } from '../src/execution/wake.ts'

const engineer = 'engineer-1' as PeerId
const reviewer = 'reviewer-1' as PeerId
const checkout = '/work/widgets'

/** A stream a test writes into. */
class Feed {
  readonly #queue: ProviderEvent[] = []
  #wake: (() => void) | undefined
  #closed = false
  push(...events: ProviderEvent[]): void {
    this.#queue.push(...events)
    this.#wake?.()
  }
  close(): void {
    this.#closed = true
    this.#wake?.()
  }
  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: async () => {
        for (;;) {
          const event = this.#queue.shift()
          if (event !== undefined) return { value: event, done: false }
          if (this.#closed) return { value: undefined, done: true }
          await new Promise<void>((resolve) => {
            this.#wake = resolve
          })
        }
      },
      return: async () => ({ value: undefined, done: true }),
    }
  }
}

interface Opened {
  readonly sessionId: string
  readonly peerId: string
  readonly how: 'start' | 'resume'
  readonly ref: string
  readonly spec: SessionSpec
}

const at = () => systemClock.now()

/**
 * A provider with a stream per session. Each session's opening turn starts at
 * once and ends when the test says (`endOpening`), or at once with `autoOpen`.
 */
const fakeProvider = (options: { autoOpen?: boolean; resumeFails?: boolean } = {}) => {
  const feeds = new Map<string, Feed>()
  const opened: Opened[] = []
  const sent: { sessionId: string; text: string }[] = []
  const calls: string[] = []
  let n = 0
  const open = (spec: SessionSpec, how: 'start' | 'resume', ref: string): SessionHandle => {
    n += 1
    const sessionId = `ses_${String(n).padStart(16, '0')}`
    const briefTurnId = `trn_${String(n).padStart(16, '0')}` as TurnId
    const feed = new Feed()
    feeds.set(sessionId, feed)
    opened.push({ sessionId, peerId: spec.peerId, how, ref, spec })
    feed.push({ type: 'turn.started', turnId: briefTurnId, at: at() })
    if (options.autoOpen !== false) feed.push({ type: 'turn.ended', turnId: briefTurnId, at: at(), reason: 'completed' })
    return { sessionId, sessionRef: ref as ProviderSessionRef, peerId: spec.peerId, providerId: 'claude', model: spec.model, permissionMode: spec.permissionMode, briefTurnId }
  }
  const provider = {
    id: 'claude',
    capabilities: { resume: true, modelSwitch: true, usageTokens: true, usageCost: true, structuredOutput: true, permissionModes: ['default', 'plan'] },
    start: async (spec: SessionSpec) => open(spec, 'start', `chat-${spec.peerId}-${String(n + 1)}`),
    resume: async (ref: ProviderSessionRef, spec: SessionSpec) => {
      if (options.resumeFails === true) throw new Error('the session could not be resumed')
      return open(spec, 'resume', ref)
    },
    events: (handle: SessionHandle) => feeds.get(handle.sessionId) as Feed,
    send: async (handle: SessionHandle, turn: Turn) => {
      sent.push({ sessionId: handle.sessionId, text: turn.text })
      const turnId = `trn_${String(sent.length).padStart(15, '0')}x` as TurnId
      feeds.get(handle.sessionId)?.push({ type: 'turn.started', turnId, at: at() }, { type: 'turn.ended', turnId, at: at(), reason: 'completed' })
      return turnId
    },
    interrupt: async (handle: SessionHandle) => {
      calls.push(`interrupt:${handle.sessionId}`)
    },
    stop: async (handle: SessionHandle) => {
      calls.push(`stop:${handle.sessionId}`)
      const feed = feeds.get(handle.sessionId)
      feed?.push({ type: 'session.ended', reason: 'stopped' })
      feed?.close()
    },
    status: async () => 'idle',
    usage: async () => ({ contextTokens: 10, contextLimit: 200_000 }),
    attachCommand: (ref: ProviderSessionRef, spec: SessionSpec) => ({ executable: 'claude', args: ['--resume', ref, '--model', spec.model] }),
  } as unknown as Provider
  /** End the opening turn of the newest session for a peer. */
  const endOpening = (peerId: string) => {
    const last = [...opened].reverse().find((o) => o.peerId === peerId)
    const index = opened.indexOf(last as Opened) + 1
    feeds.get(last?.sessionId ?? '')?.push({ type: 'turn.ended', turnId: `trn_${String(index).padStart(16, '0')}` as TurnId, at: at(), reason: 'completed' })
  }
  /** A turn that stays running until `endTurn`. */
  const startTurn = (sessionId: string) => feeds.get(sessionId)?.push({ type: 'turn.started', turnId: 'trn_000000000000feed' as TurnId, at: at() })
  const endTurn = (sessionId: string, reason: 'completed' | 'interrupted' = 'completed') =>
    feeds.get(sessionId)?.push({ type: 'turn.ended', turnId: 'trn_000000000000feed' as TurnId, at: at(), reason })
  return { provider, opened, sent, calls, endOpening, startTurn, endTurn }
}

const profile = decodeProfile({
  profile: 'test',
  repos: ['acme/widgets'],
  checkouts: { 'acme/widgets': checkout },
  peers: [
    { id: engineer, role: 'engineer', provider: 'claude', model: 'claude-opus-5-5' },
    { id: reviewer, role: 'reviewer', provider: 'claude', model: 'claude-sonnet-5-5', permissionMode: 'plan' },
  ],
})

const registered = (peerId: PeerId, role: string): AppendEvent =>
  ({ ts: at(), type: 'peer.registered', subject: peerId, actor: 'user', data: { peerId, role, providerId: 'claude', model: 'claude-opus-5-5', permissionMode: 'default' } }) as unknown as AppendEvent

/** A supervisor on a store, with the Mailbox and the delivery-on-start wake wired as compose.ts wires them. */
const fleet = async (fake: ReturnType<typeof fakeProvider>, store?: EventStore) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'fleet-hold-'))
  const opened = store ?? (await openSqliteStore({ path: join(stateDir, 'store.sqlite') }))
  if (store === undefined) await opened.append([registered(engineer, 'engineer'), registered(reviewer, 'reviewer')])
  let mailboxRef: ReturnType<typeof createMailbox> | undefined
  const wake = createWakingSink({
    append: (batch) => opened.append(batch),
    read: (from, limit) => opened.read(from, limit),
    scheduler: () => ({ wake: async () => undefined }),
  })
  const supervisor: Supervisor = createSupervisor({
    profile,
    paths: profilePaths('test', { home: stateDir }),
    read: opened.reader(),
    store: wake,
    providers: new Map([['claude', fake.provider]]),
    providerEnv: async () => ({ ANTHROPIC_BASE_URL: 'https://endpoint.example' }),
  })
  const mailbox = createMailbox({
    store: { append: wake.append, messages: opened.reader().messages },
    sessions: supervisor,
    briefs: supervisor.briefs,
  })
  mailboxRef = mailbox
  wake.listen(deliverOnSessionStart(mailboxRef))
  const events = async (): Promise<readonly FleetEvent[]> => opened.read(1, 10_000)
  return { store: opened, supervisor, mailbox, events }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const sessionOf = (fake: ReturnType<typeof fakeProvider>, peerId: string) =>
  [...fake.opened].reverse().find((o) => o.peerId === peerId) as Opened

test('a hold waits for the running turn, then stops the peer and records the ref; the other peer is untouched', async () => {
  const fake = fakeProvider()
  const f = await fleet(fake)
  await f.supervisor.start()
  await settle()
  const first = sessionOf(fake, engineer)
  fake.startTurn(first.sessionId)
  await settle()

  let held = false
  const hold = f.supervisor.hold(engineer, { by: 'user' }).then((answer) => {
    held = true
    return answer
  })
  await settle()
  assert.equal(held, false, 'mid-turn: the hold waits for the boundary')
  assert.ok(!f.supervisor.running().includes(engineer), 'but no delivery reaches it while it waits')
  fake.endTurn(first.sessionId)
  const answer = await hold

  assert.equal(answer.sessionRef, first.ref)
  assert.deepEqual(answer.command, { executable: 'claude', args: ['--resume', first.ref, '--model', 'claude-opus-5-5'] })
  assert.equal(answer.env['FLEET_PEER'], engineer)
  assert.equal(answer.env['ANTHROPIC_BASE_URL'], 'https://endpoint.example', 'the same env the headless session got')
  assert.equal(answer.cwd, checkout)
  assert.ok(fake.calls.includes(`stop:${first.sessionId}`))
  assert.equal((await f.store.reader().peers.get(engineer))?.state, 'held')
  const heldEvent = (await f.events()).find((event) => event.type === 'peer.held')
  assert.equal(heldEvent?.type === 'peer.held' ? heldEvent.data.sessionRef : undefined, first.ref)
  assert.ok(f.supervisor.running().includes(reviewer), "the other peer's session is untouched")
  assert.ok(!fake.calls.some((call) => call === `stop:${sessionOf(fake, reviewer).sessionId}`))

  assert.deepEqual(await f.supervisor.hold(engineer, { by: 'user' }), answer, 'held again: the same answer')
  await f.supervisor.stop()
})

test('a hold during the opening turn waits for it to end', async () => {
  const fake = fakeProvider({ autoOpen: false })
  const f = await fleet(fake)
  await f.supervisor.start()
  await settle()
  let held = false
  const hold = f.supervisor.hold(engineer, { by: 'user' }).then(() => {
    held = true
  })
  await settle()
  assert.equal(held, false, 'the brief is still in flight')
  fake.endOpening(engineer)
  await hold
  assert.equal((await f.store.reader().peers.get(engineer))?.state, 'held')
  fake.endOpening(reviewer)
  await f.supervisor.stop()
})

test('a hold with now interrupts the turn instead of waiting for it', async () => {
  const fake = fakeProvider()
  const f = await fleet(fake)
  await f.supervisor.start()
  await settle()
  const first = sessionOf(fake, engineer)
  fake.startTurn(first.sessionId)
  await settle()
  const hold = f.supervisor.hold(engineer, { now: true, by: 'user' })
  await settle()
  assert.ok(fake.calls.includes(`interrupt:${first.sessionId}`))
  fake.endTurn(first.sessionId, 'interrupted')
  await hold
  await f.supervisor.stop()
})

test('release resumes the same ref with the handback note, not the brief, and records resumed: true', async () => {
  const fake = fakeProvider()
  const f = await fleet(fake)
  await f.supervisor.start()
  await settle()
  const first = sessionOf(fake, engineer)
  await f.supervisor.hold(engineer, { by: 'user' })

  const released = await f.supervisor.release(engineer)
  await settle()
  assert.deepEqual(released, { peerId: engineer, resumed: true })
  const second = sessionOf(fake, engineer)
  assert.equal(second.how, 'resume')
  assert.equal(second.ref, first.ref)
  assert.match(second.spec.opening ?? '', /A person took this session over from .* and has handed it back/)
  assert.doesNotMatch(second.spec.opening ?? '', /engineer/, 'the brief is not in it')
  const log = await f.events()
  const start = log.filter((event) => event.type === 'session.started').at(-1)
  assert.equal(start?.type === 'session.started' ? start.data.resumed : undefined, true)
  const releasedAt = log.findIndex((event) => event.type === 'peer.released')
  assert.ok(releasedAt >= 0 && releasedAt < log.indexOf(start as FleetEvent), 'released before the new session says it started')
  assert.ok(f.supervisor.running().includes(engineer))
  await f.supervisor.stop()
})

test('release falls back to a fresh start when the resume is refused, and says why', async () => {
  const fake = fakeProvider({ resumeFails: true })
  const f = await fleet(fake)
  await f.supervisor.start()
  await settle()
  await f.supervisor.hold(engineer, { by: 'user' })
  const released = await f.supervisor.release(engineer)
  assert.equal(released.resumed, false)
  assert.match(released.reason ?? '', /resume failed: the session could not be resumed/)
  const fresh = sessionOf(fake, engineer)
  assert.equal(fresh.how, 'start')
  assert.equal(fresh.spec.opening, undefined, 'a fresh session gets the brief')
  const event = (await f.events()).find((row) => row.type === 'peer.released')
  assert.equal(event?.type === 'peer.released' ? event.data.resumed : undefined, false)
  assert.ok(f.supervisor.running().includes(engineer), 'never left held with nobody holding it')
  await f.supervisor.stop()
})

test('a restarted daemon starts nothing for a held peer, and the hold answers the same ref', async () => {
  const fake = fakeProvider()
  const f = await fleet(fake)
  await f.supervisor.start()
  await settle()
  const answer = await f.supervisor.hold(engineer, { by: 'user' })
  await f.supervisor.stop()

  const again = await fleet(fake, f.store)
  const before = fake.opened.length
  await again.supervisor.start()
  await settle()
  const startedNow = fake.opened.slice(before).map((o) => o.peerId)
  assert.deepEqual(startedNow, [reviewer], 'only the peer nobody holds')
  assert.equal((await again.supervisor.hold(engineer, { by: 'user' })).sessionRef, answer.sessionRef)
  const released = await again.supervisor.release(engineer)
  assert.equal(released.resumed, true)
  await again.supervisor.stop()
})

test('mail sent while a peer is held waits, and is delivered once after the release', async () => {
  const fake = fakeProvider()
  const f = await fleet(fake)
  await f.supervisor.start()
  await settle()
  await f.supervisor.hold(engineer, { by: 'user' })

  const sent = await f.mailbox.send({ to: engineer, from: 'user', kind: 'info', briefVersion: 1, body: 'take #42' })
  assert.ok(sent.ok)
  const tried = await f.mailbox.deliver(engineer)
  assert.ok(tried.ok && tried.value.delivered.length === 0, 'nothing reaches a held peer')
  assert.equal((await f.mailbox.pending(engineer)).length, 1)
  assert.equal((await f.supervisor.hold(engineer, { by: 'user' })).pendingMessages, 1)

  await f.supervisor.release(engineer)
  await settle()
  const resumed = sessionOf(fake, engineer)
  assert.match(resumed.spec.opening ?? '', /1 message arrived for you meanwhile/)
  const deliveries = fake.sent.filter((row) => row.text === 'take #42')
  assert.equal(deliveries.length, 1, 'delivered once')
  assert.equal(deliveries[0]?.sessionId, resumed.sessionId, 'to the resumed session')
  await f.supervisor.stop()
})

test('a stopped peer is skipped by start and by a restart, keeps its mail, and starts again from its ref', async () => {
  const fake = fakeProvider()
  const f = await fleet(fake)
  await f.supervisor.start()
  await settle()
  const first = sessionOf(fake, engineer)
  const reviewerSession = sessionOf(fake, reviewer)
  const stopped = await f.supervisor.stopPeer(engineer, { by: 'user' })
  assert.equal(stopped.sessionRef, first.ref)
  assert.equal((await f.store.reader().peers.get(engineer))?.state, 'stopped')

  await f.supervisor.start()
  await settle()
  assert.equal(sessionOf(fake, engineer).sessionId, first.sessionId, 'start() did not restart it')
  await assert.rejects(f.supervisor.hold(engineer, { by: 'user' }), /is stopped/)
  await assert.rejects(f.supervisor.release(engineer), /is stopped, not held/)
  assert.ok(!fake.calls.includes(`stop:${reviewerSession.sessionId}`), "stopping one peer did not touch the other's session")
  assert.ok(f.supervisor.running().includes(reviewer))
  await f.supervisor.stop()

  const again = await fleet(fake, f.store)
  await again.supervisor.start()
  await settle()
  assert.ok(!again.supervisor.running().includes(engineer), 'stopped survives a restart')

  const started = await again.supervisor.startPeer(engineer)
  assert.deepEqual(started, { peerId: engineer, resumed: true })
  const resumed = sessionOf(fake, engineer)
  assert.equal(resumed.ref, first.ref)
  assert.match(resumed.spec.opening ?? '', /This peer was stopped from .* and has been started again/)
  await again.supervisor.stop()
})

test('the handback note counts the waiting mail', () => {
  assert.match(handbackNote('held', 'a', 'b', 0), /No messages arrived/)
  assert.match(handbackNote('held', 'a', 'b', 2), /2 messages arrived for you meanwhile and follow this one/)
})
