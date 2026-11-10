/**
 * The wrapper's job is the loop: map events, count turns, and stop the session
 * at the right boundary — including the hard part, asking a peer a question
 * while the answer only arrives on the stream the loop itself is reading.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fixedClock, type PeerId, type QuestionId, type TurnId } from '@fleet/foundation-core'
import type { ProviderEvent } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle } from '@fleet/runtime-provider-sdk'

import { PeerSession, type PurgeOutcome, type SessionRecord } from '../src/index.ts'

const peerId = 'engineer-1' as PeerId
const turnId = 'trn_0123456789abcdef' as TurnId
const handle = (sessionId: string, model = 'claude-sonnet-5-5'): SessionHandle => ({
  sessionId,
  sessionRef: 'sess_x' as SessionHandle['sessionRef'],
  peerId,
  providerId: 'claude',
  model,
  permissionMode: 'default',
  briefTurnId: 'trn_0123456789abcdef' as TurnId,
})

/** A stream a test pushes into, so the wrapper never waits on a real process. */
class Feed {
  readonly #queue: ProviderEvent[] = []
  #waiter: ((result: IteratorResult<ProviderEvent>) => void) | undefined
  #closed = false

  push(...events: readonly ProviderEvent[]): void {
    for (const event of events) {
      if (this.#waiter !== undefined) {
        const waiter = this.#waiter
        this.#waiter = undefined
        waiter({ value: event, done: false })
      } else {
        this.#queue.push(event)
      }
    }
  }

  close(): void {
    this.#closed = true
    if (this.#waiter !== undefined) {
      const waiter = this.#waiter
      this.#waiter = undefined
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: () => {
        const queued = this.#queue.shift()
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.#waiter = resolve
        })
      },
      return: () => Promise.resolve({ value: undefined, done: true }),
    }
  }
}

const started = (): ProviderEvent => ({ type: 'turn.started', turnId, at: '2026-11-10T09:00:00.000Z' })
const ended = (reason: 'completed' | 'interrupted' | 'failed' = 'completed'): ProviderEvent => ({
  type: 'turn.ended',
  turnId,
  at: '2026-11-10T09:00:01.000Z',
  reason,
})

interface Rig {
  readonly feeds: Map<string, Feed>
  readonly sent: readonly string[]
  readonly records: SessionRecord[]
  readonly provider: Provider
  /** Every recovery the wrapper asked for, with the failure it was told about. */
  readonly recovered: { from: string; failure: unknown }[]
  readonly recover: (from: SessionHandle, failure: unknown) => Promise<SessionHandle>
}

const rig = (usage: (h: SessionHandle) => { contextTokens: number; contextLimit: number } = () => ({
  contextTokens: 100,
  contextLimit: 1_000,
})): Rig => {
  const feeds = new Map<string, Feed>()
  const sent: string[] = []
  const records: SessionRecord[] = []
  const recovered: { from: string; failure: unknown }[] = []

  const recover = async (from: SessionHandle, failure: unknown): Promise<SessionHandle> => {
    recovered.push({ from: from.sessionId, failure })
    return handle('ses_cccccccccccccccc')
  }

  const provider = {
    id: 'claude',
    capabilities: {
      resume: true,
      modelSwitch: true,
      usageTokens: true,
      usageCost: true,
      structuredOutput: true,
      permissionModes: ['default'],
    },
    events: (h: SessionHandle) => {
      const feed = new Feed()
      feeds.set(h.sessionId, feed)
      return feed
    },
    send: async (h: SessionHandle, turn: { text: string }) => {
      sent.push(turn.text)
      feeds.get(h.sessionId)?.push(started(), ended())
      return turnId
    },
    usage: async (h: SessionHandle) => usage(h),
    stop: async (h: SessionHandle) => {
      // The adapter synthesises `session.ended` when we stop it (§4); the rig does the same.
      const feed = feeds.get(h.sessionId)
      feed?.push({ type: 'session.ended', reason: 'stopped' })
      feed?.close()
    },
  } as unknown as Provider

  return { feeds, sent, records, provider, recovered, recover }
}

/** A purge stub that does what the real one does to the stream: ask, then stop. */
const stubPurge = (provider: Provider, options: { readonly fail?: Error } = {}) => {
  const calls: { sessionId: string; asked: readonly string[] }[] = []
  const purge = async (input: { handle: SessionHandle; ask: (text: string) => Promise<void> }): Promise<PurgeOutcome> => {
    const asked: string[] = []
    calls.push({ sessionId: input.handle.sessionId, asked })
    await input.ask('write your state file')
    asked.push('write your state file')
    // Stop ends the old stream, which is what lets the loop collect this purge.
    await provider.stop(input.handle)
    if (options.fail !== undefined) throw options.fail
    return {
      handle: handle('ses_bbbbbbbbbbbbbbbb'),
      stateFile: {
        peerId,
        goal: 'g',
        done: [],
        inFlight: [],
        next: [],
        decisions: [],
        openQuestions: [],
        briefVersion: 1,
      },
      degraded: false,
    }
  }
  return { calls, purge }
}

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for a condition a real loop would reach in microseconds, and fail loudly if it never does. */
const until = async (condition: () => boolean, what: string, ms = 1_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(5)
  }
}

test('events become peer states, and a completed turn that is under the limit keeps going', async () => {
  const r = rig()
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.8, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: async () => {
      throw new Error('must not purge')
    },
    recover: r.recover,
  })

  const run = session.run()
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(
    started(),
    { type: 'tool.use', turnId, tool: 'Bash' },
    ended(),
    { type: 'session.ended', reason: 'exit', code: 0 },
  )
  await run

  assert.deepEqual(
    r.records.map((record) => (record.type === 'peer.state' ? record.state : record.type)),
    ['working', 'idle', 'ended', 'session.ended'],
  )
  assert.deepEqual(session.state, 'ended')
})

test('at the limit the session purges, comes back on the new handle, and keeps running', async () => {
  // The first session is over the limit; a fresh one is not, so a purge cannot loop.
  const r = rig((h) =>
    h.sessionId === 'ses_aaaaaaaaaaaaaaaa'
      ? { contextTokens: 900, contextLimit: 1_000 }
      : { contextTokens: 100, contextLimit: 1_000 },
  )
  const stub = stubPurge(r.provider)
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: stub.purge,
    recover: r.recover,
  })

  const run = session.run()
  await wait()
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(started(), ended())
  await wait()

  // The purge asked through the live stream: the ask's own turn ended on the
  // same feed the loop was reading, and did not count as work.
  assert.deepEqual(stub.calls, [{ sessionId: 'ses_aaaaaaaaaaaaaaaa', asked: ['write your state file'] }])
  assert.deepEqual(r.sent, ['write your state file'])

  // The old session's stream is closed by the purge's stop; the new one runs.
  await until(() => r.feeds.has('ses_bbbbbbbbbbbbbbbb'), 'the fresh session to subscribe')
  assert.equal(session.handle.sessionId, 'ses_bbbbbbbbbbbbbbbb')
  r.feeds.get('ses_bbbbbbbbbbbbbbbb')?.push(started(), ended(), { type: 'session.ended', reason: 'exit' })
  await run

  // The session this purge replaced is `purged`, not `stopped` or `failed`: it
  // did exactly what §8 asked. The fresh one then ends on its own.
  const ends = r.records.filter((record) => record.type === 'session.ended')
  assert.deepEqual(
    ends.map((record) => (record.type === 'session.ended' ? record.reason : undefined)),
    ['purged', 'exit'],
  )
})

test('a session that ends while the purge waits for its answer does not hang the supervisor', async () => {
  // The peer never answers: the session crashes mid-ask. The purge must be
  // released and restart the peer, not wait for a turn that will never come.
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stateFile = {
    peerId,
    goal: 'g',
    done: [],
    inFlight: [],
    next: [],
    decisions: [],
    openQuestions: [],
    briefVersion: 1,
  }
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: async (input) => {
      // Resolved by the wrapper when the stream ends without an answer.
      await input.ask('write your state file')
      return { handle: handle('ses_bbbbbbbbbbbbbbbb'), stateFile, degraded: true, reason: 'the session ended first' }
    },
    recover: r.recover,
  })

  const run = session.run()
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(started(), ended())

  await until(() => r.sent.length === 1, 'the purge to ask for the state file')
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push({ type: 'session.ended', reason: 'crash', code: 1 })

  await until(() => r.feeds.has('ses_bbbbbbbbbbbbbbbb'), 'the purge to restart the peer')
  r.feeds.get('ses_bbbbbbbbbbbbbbbb')?.push({ type: 'session.ended', reason: 'exit' })
  await run
  assert.equal(session.handle.sessionId, 'ses_bbbbbbbbbbbbbbbb')
})

test('a purge whose restart fails recovers the peer, rather than leaving it with no session', async () => {
  const failure = new Error('restart failed')
  // Only the first session is over the limit: the recovery is not a purge.
  const r = rig((h) =>
    h.sessionId === 'ses_aaaaaaaaaaaaaaaa'
      ? { contextTokens: 900, contextLimit: 1_000 }
      : { contextTokens: 100, contextLimit: 1_000 },
  )
  const stub = stubPurge(r.provider, { fail: failure })
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: stub.purge,
    recover: r.recover,
  })

  const run = session.run()
  await wait()
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(started(), ended())

  // The recovery is asked for once, told which session failed and why, and the
  // loop carries on reading the recovered session's stream.
  await until(() => r.recovered.length === 1, 'the recovery to be asked for')
  assert.equal(r.recovered[0]?.from, 'ses_aaaaaaaaaaaaaaaa')
  assert.equal(r.recovered[0]?.failure, failure)
  assert.equal(session.handle.sessionId, 'ses_cccccccccccccccc')

  await until(() => r.feeds.has('ses_cccccccccccccccc'), 'the recovered session to subscribe')
  r.feeds.get('ses_cccccccccccccccc')?.push(started(), ended(), { type: 'session.ended', reason: 'exit' })
  await run
  assert.equal(session.state, 'ended')
})

test('a peer that fails again after a recovery is reported, not restarted forever', async () => {
  // Every session is over the limit and every purge fails: without a bound this
  // is an unbounded start/fail loop, which looks exactly like a healthy peer.
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stub = stubPurge(r.provider, { fail: new Error('restart failed') })
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: stub.purge,
    recover: r.recover,
  })

  const run = session.run()
  await until(() => r.feeds.has('ses_aaaaaaaaaaaaaaaa'), 'the stream to be subscribed')
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(started(), ended())

  await until(() => r.recovered.length === 1, 'the recovery to be asked for')
  // The recovered session runs into the same wall.
  await until(() => r.feeds.has('ses_cccccccccccccccc'), 'the recovered session to subscribe')
  r.feeds.get('ses_cccccccccccccccc')?.push(started(), ended())

  await assert.rejects(run, /restart failed/)
  assert.equal(r.recovered.length, 1, 'one recovery, then the failure is reported')
})

test('a recovery that fails too rejects run(): no session must be visible, not idle', async () => {
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stub = stubPurge(r.provider, { fail: new Error('restart failed') })
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: stub.purge,
    recover: async () => {
      throw new Error('the provider will not start')
    },
  })

  const run = session.run()
  await wait()
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(started(), ended())

  await assert.rejects(run, /the provider will not start/)
})

test('no mail is delivered into a session while it is being purged', async () => {
  // Only the first session is over the limit, so the fresh one is not purged again.
  const r = rig((h) =>
    h.sessionId === 'ses_aaaaaaaaaaaaaaaa'
      ? { contextTokens: 900, contextLimit: 1_000 }
      : { contextTokens: 100, contextLimit: 1_000 },
  )
  // A purge the test holds open, so "during a purge" is a state it can observe
  // rather than a race it has to win.
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: async (input) => {
      await input.ask('write your state file')
      await held
      await r.provider.stop(input.handle)
      return {
        handle: handle('ses_bbbbbbbbbbbbbbbb'),
        stateFile: {
          peerId,
          goal: 'g',
          done: [],
          inFlight: [],
          next: [],
          decisions: [],
          openQuestions: [],
          briefVersion: 1,
        },
        degraded: false,
      }
    },
    recover: r.recover,
  })

  const run = session.run()
  const mail = { text: 'review #33', kind: 'info' as const, briefVersion: 1 }
  await until(() => r.feeds.has('ses_aaaaaaaaaaaaaaaa'), 'the stream to be subscribed')
  // Before a purge, delivery is the ordinary path.
  assert.equal(await session.deliver(mail), turnId)

  await until(() => r.sent.length === 2, 'the purge to ask for the state file')

  // The old session is about to be stopped; a turn sent now would be read by
  // nobody, so the refusal is typed and the message stays in the mailbox.
  await assert.rejects(session.deliver(mail), (thrown: unknown) => {
    assert.equal((thrown as { code?: string }).code, 'conflict')
    return true
  })

  release()
  await until(() => session.handle.sessionId === 'ses_bbbbbbbbbbbbbbbb', 'the handle to be swapped')
  // Once the replacement is running, mail is accepted again.
  await session.deliver(mail)

  r.feeds.get('ses_bbbbbbbbbbbbbbbb')?.push({ type: 'session.ended', reason: 'exit' })
  await run
})

test('a question still open at a turn boundary does not trigger a purge', async () => {
  // Over the limit from the first turn: any real boundary would purge.
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stub = stubPurge(r.provider)
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: stub.purge,
    recover: r.recover,
  })

  const run = session.run()
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(
    started(),
    // The peer is waiting on a person, not on itself: purging now would
    // interrupt the one thing a fresh session cannot re-create.
    {
      type: 'question.asked',
      turnId,
      questionId: 'qst_0123456789abcdef' as QuestionId,
      questions: [{ question: 'ship it?', options: [{ label: 'yes' }, { label: 'no' }] }],
    },
    ended(),
  )
  await wait(50)
  assert.deepEqual(stub.calls, [], 'no purge while a question is pending')

  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push({ type: 'session.ended', reason: 'exit' })
  await run
})

test('a turn still in flight at a turn boundary does not trigger a purge', async () => {
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stub = stubPurge(r.provider)
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: stub.purge,
    recover: r.recover,
  })

  const run = session.run()
  await until(() => r.feeds.has('ses_aaaaaaaaaaaaaaaa'), 'the stream to be subscribed')
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(started(), started(), ended())
  await wait(50)
  assert.deepEqual(stub.calls, [], 'the first end is not a boundary while a turn is open')

  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(ended())
  await until(() => stub.calls.length === 1, 'the last open turn to end, which is a boundary')

  // The purge stops the old session and the wrapper moves to the fresh one.
  await until(() => r.feeds.has('ses_bbbbbbbbbbbbbbbb'), 'the fresh session to subscribe')
  r.feeds.get('ses_bbbbbbbbbbbbbbbb')?.push({ type: 'session.ended', reason: 'exit' })
  await run
})

test('records are appended in order and awaited before the next event is read', async () => {
  const r = rig()
  const appended: string[] = []
  let inFlight = 0
  let overlapped = false
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.8, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: async (record) => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 5))
      appended.push(record.type === 'peer.state' ? record.state : record.type)
      inFlight -= 1
    },
    purge: async () => {
      throw new Error('must not purge')
    },
    recover: r.recover,
  })

  const run = session.run()
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(started(), ended(), { type: 'session.ended', reason: 'exit', code: 0 })
  await run

  // Awaited, so `run()` only resolves once the last append landed — and the
  // appends never overlap, which is what keeps the store's order the stream's.
  assert.deepEqual(appended, ['working', 'idle', 'ended', 'session.ended'])
  assert.equal(overlapped, false)
})
