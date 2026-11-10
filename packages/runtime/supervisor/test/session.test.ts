/**
 * The wrapper's job is the loop: map events, count turns, and stop the session
 * at the right boundary — including the hard part, asking a peer a question
 * while the answer only arrives on the stream the loop itself is reading.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fixedClock, type PeerId, type QuestionId, type TurnId } from '@fleet/foundation-core'
import { appendIssues, type ProviderEvent, type Usage } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle } from '@fleet/runtime-provider-sdk'

import { PeerSession, PurgeRestartFailed, type PurgeOutcome, type SessionRecord } from '../src/index.ts'

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
  #rejecter: ((reason: unknown) => void) | undefined
  #closed = false
  /** The failure this stream will throw instead of ending, set by `fail()`. */
  #failure: { readonly error: unknown } | undefined

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

  /**
   * The stream itself fails, the way an adapter whose child process dies mid-read
   * does: `next()` rejects instead of the provider synthesising `session.ended`.
   */
  fail(error: unknown): void {
    this.#failure = { error }
    if (this.#rejecter !== undefined) {
      const reject = this.#rejecter
      this.#rejecter = undefined
      this.#waiter = undefined
      reject(error)
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
        if (this.#failure !== undefined) return Promise.reject(this.#failure.error)
        const queued = this.#queue.shift()
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => {
          this.#waiter = resolve
          this.#rejecter = reject
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
  /** Every recovery the wrapper asked for, with the failure and handoff it was told about. */
  readonly recovered: { from: string; failure: unknown; stateFile: unknown }[]
  readonly recover: (
    from: SessionHandle,
    failure: unknown,
    stateFile: unknown,
  ) => Promise<SessionHandle>
}

const rig = (
  usage: (h: SessionHandle) => Usage = () => ({
    contextTokens: 100,
    contextLimit: 1_000,
  }),
  /**
   * A provider that stops a session without synthesising `session.ended` — the
   * one shape the loop cannot learn a session ended from, and so the only way a
   * replacement can inherit work. Every real adapter emits it (§4); the fault
   * test below is the one that asks what happens when one does not.
   */
  options: { readonly silentStop?: boolean } = {},
): Rig => {
  const feeds = new Map<string, Feed>()
  const sent: string[] = []
  const records: SessionRecord[] = []
  const recovered: { from: string; failure: unknown; stateFile: unknown }[] = []

  const recover = async (
    from: SessionHandle,
    failure: unknown,
    stateFile: unknown,
  ): Promise<SessionHandle> => {
    recovered.push({ from: from.sessionId, failure, stateFile })
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
      if (options.silentStop !== true) feed?.push({ type: 'session.ended', reason: 'stopped' })
      feed?.close()
    },
  } as unknown as Provider

  return { feeds, sent, records, provider, recovered, recover }
}

/** A purge stub that does what the real one does to the stream: ask, then stop. */
const stubPurge = (
  provider: Provider,
  options: {
    readonly fail?: Error
    /** Run against the old stream just before the purge stops it: how a test plants work the stop will strand. */
    readonly beforeStop?: () => void
  } = {},
) => {
  const calls: { sessionId: string; asked: readonly string[] }[] = []
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
  const purge = async (input: { handle: SessionHandle; ask: (text: string) => Promise<void> }): Promise<PurgeOutcome> => {
    const asked: string[] = []
    calls.push({ sessionId: input.handle.sessionId, asked })
    await input.ask('write your state file')
    asked.push('write your state file')
    options.beforeStop?.()
    // Stop ends the old stream, which is what lets the loop collect this purge.
    await provider.stop(input.handle)
    // A restart that fails after the handoff, as `selfPurge` reports it: the
    // state file is already recorded, so the failure carries it out.
    if (options.fail !== undefined) throw new PurgeRestartFailed(stateFile, false, options.fail)
    return { handle: handle('ses_bbbbbbbbbbbbbbbb'), stateFile, degraded: false }
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
    limits: { contextRatio: 0.8, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
    r.records.map((record) => (record.type === 'peer.state_changed' ? record.data.state : record.type)),
    ['working', 'idle', 'ended', 'session.ended'],
  )
  assert.deepEqual(session.state, 'ended')
  // What the wrapper wrote is what the store accepts: the records are the
  // registry's own events, so the append boundary has nothing to object to.
  assert.deepEqual(r.records.flatMap((record) => appendIssues(record)), [])
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
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
    ends.map((record) => (record.type === 'session.ended' ? record.data.endReason : undefined)),
    // The purge's own stop is the restart, not an end; the fresh session's
    // clean exit is `completed`, which is the contract's word for it (§3, §4).
    ['purged', 'completed'],
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
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
  // The handoff the purge already wrote and recorded outlives the failed
  // restart: the recovered session is started from it, not from role + brief.
  assert.ok(r.recovered[0]?.failure instanceof PurgeRestartFailed)
  assert.equal(r.recovered[0]?.failure.cause, failure)
  assert.equal((r.recovered[0]?.stateFile as { goal?: string }).goal, 'g')
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
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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

  await assert.rejects(run, /could not be started/)
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
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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

test('a question answered inside its turn does not hold the purge off: the turn ending is the proof', async () => {
  // The answer never appears on the stream, so the turn's own end is the only
  // evidence it was answered — a turn cannot end while its question is open.
  // Waiting for the *next* turn would leave an idle peer over its limit
  // unpurged for as long as nobody sends it anything.
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stub = stubPurge(r.provider)
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
    {
      type: 'question.asked',
      turnId,
      questionId: 'qst_0123456789abcdef' as QuestionId,
      questions: [{ question: 'ship it?', options: [{ label: 'yes' }, { label: 'no' }] }],
    },
    ended(),
  )

  await until(() => stub.calls.length === 1, 'the purge to fire at the boundary that answered the question')
  await until(() => r.feeds.has('ses_bbbbbbbbbbbbbbbb'), 'the fresh session to subscribe')
  r.feeds.get('ses_bbbbbbbbbbbbbbbb')?.push({ type: 'session.ended', reason: 'exit' })
  await run
})

test('a stream that throws ends the session in the store before the peer is recovered', async () => {
  // An adapter that dies mid-read rejects out of `events()` and never gets to
  // synthesise its own `session.ended`. Without the record below, the store
  // would show a session that started and never ended — and a replay would read
  // it as live, while the handle behind it is dead (§3, §4, §8).
  const r = rig()
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.8, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
  await until(() => r.feeds.has('ses_aaaaaaaaaaaaaaaa'), 'the stream to be subscribed')
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.fail(new Error('the adapter blew up'))

  await until(() => r.recovered.length === 1, 'the recovery to be asked for')
  const ends = r.records.filter((record) => record.type === 'session.ended')
  assert.equal(ends.length, 1, 'the dead session is recorded as ended, exactly once')
  assert.equal(ends[0]?.type === 'session.ended' ? ends[0].data.endReason : undefined, 'crashed')
  assert.equal(ends[0]?.subject, 'ses_aaaaaaaaaaaaaaaa')
  // What the wrapper wrote is still what the store accepts.
  assert.deepEqual(r.records.flatMap((record) => appendIssues(record)), [])

  await until(() => r.feeds.has('ses_cccccccccccccccc'), 'the recovered session to subscribe')
  r.feeds.get('ses_cccccccccccccccc')?.push({ type: 'session.ended', reason: 'exit' })
  await run
})

test('a session that dies with work open leaves none of it to its replacement', async () => {
  // A pending question that outlives its session must not happen. Nobody can
  // answer the question or the approval: the stream that asked them is gone, so
  // the person it named is gone too. The replacement starts owing nothing and
  // reaches a purge boundary like any other idle peer — where the old rule
  // counted the dead session's entries as a person still being waited on and
  // left the peer un-purgeable for the rest of its life, silently.
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stub = stubPurge(r.provider)
  const questionId = 'qst_0123456789abcdef' as QuestionId
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: stub.purge,
    recover: r.recover,
  })

  const run = session.run()
  await until(() => r.feeds.has('ses_aaaaaaaaaaaaaaaa'), 'the stream to be subscribed')
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(
    started(),
    {
      type: 'question.asked',
      turnId,
      questionId,
      questions: [{ question: 'ship it?', options: [{ label: 'yes' }, { label: 'no' }] }],
    },
    { type: 'approval.requested', turnId, requestId: 'apr_0123456789abcdef', tool: 'Bash', summary: 'git push' },
  )
  await wait()
  assert.equal(session.state, 'waiting_input')

  // The adapter dies mid-read, so nothing abandons either of them on the stream:
  // the session's own end is the only thing that can, and it has to reach both.
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.fail(new Error('the adapter blew up'))
  await until(() => r.recovered.length === 1, 'the recovery to be asked for')
  await until(() => r.feeds.has('ses_cccccccccccccccc'), 'the recovered session to subscribe')

  // The replacement's own turn, over the limit: it purges. A foreign turn id on
  // purpose — ids are minted per turn, so the replacement's ending says nothing
  // about the turn the question was asked on.
  const ownTurn = 'trn_fedcba9876543210' as TurnId
  r.feeds.get('ses_cccccccccccccccc')?.push(
    { type: 'turn.started', turnId: ownTurn, at: '2026-11-10T09:00:02.000Z' },
    { type: 'turn.ended', turnId: ownTurn, at: '2026-11-10T09:00:03.000Z', reason: 'completed' },
  )
  await until(() => stub.calls.length === 1, 'the replacement to purge')

  await until(() => r.feeds.has('ses_bbbbbbbbbbbbbbbb'), 'the fresh session to subscribe')
  r.feeds.get('ses_bbbbbbbbbbbbbbbb')?.push({ type: 'session.ended', reason: 'exit' })
  await run

  // Nothing was recorded as a fault: inheriting is the bug, and this session
  // left nothing behind to inherit.
  assert.deepEqual(
    r.records.filter((record) => record.type === 'provider.errored'),
    [],
  )
})

test('a question still open on this session holds the purge off until its turn ends', async () => {
  // The other half of the rule: work that belongs to *this* session is a person
  // still being waited on, and the purge waits for them. Nothing about the fix
  // above makes a live question cheaper to abandon.
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stub = stubPurge(r.provider)
  const questionId = 'qst_0123456789abcdef' as QuestionId
  const askedTurn = 'trn_0123456789abcdef' as TurnId
  const ownTurn = 'trn_fedcba9876543210' as TurnId
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: stub.purge,
    recover: r.recover,
  })

  const run = session.run()
  await until(() => r.feeds.has('ses_aaaaaaaaaaaaaaaa'), 'the stream to be subscribed')
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(
    { type: 'turn.started', turnId: askedTurn, at: '2026-11-10T09:00:00.000Z' },
    { type: 'question.asked', turnId: askedTurn, questionId, questions: [{ question: 'ship it?' }] },
    // A later turn ends while the question is still open on the earlier one.
    { type: 'turn.started', turnId: ownTurn, at: '2026-11-10T09:00:02.000Z' },
    { type: 'turn.ended', turnId: ownTurn, at: '2026-11-10T09:00:03.000Z', reason: 'completed' },
  )
  await wait(50)
  assert.deepEqual(stub.calls, [], 'the peer is still waiting on a person')

  // Answered inside its turn: the ending is the proof, and the purge fires.
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push({
    type: 'turn.ended',
    turnId: askedTurn,
    at: '2026-11-10T09:00:04.000Z',
    reason: 'completed',
  })
  await until(() => stub.calls.length === 1, 'the purge to fire once the question is answered')
  await until(() => r.feeds.has('ses_bbbbbbbbbbbbbbbb'), 'the fresh session to subscribe')
  r.feeds.get('ses_bbbbbbbbbbbbbbbb')?.push({ type: 'session.ended', reason: 'exit' })
  await run
})

test('a boundary that finds work another session raised is recorded, and stops the peer', async () => {
  // The one hole left: a provider that stops a session without synthesising
  // `session.ended`, while the session it stopped was holding something. The
  // loop cannot see the end, so the work survives into the replacement, which
  // then reaches a turn boundary holding a question its session never asked.
  //
  // That is the state the design calls impossible, and it used to be answered
  // with `continue` — no purge, no record, no trace, for the rest of the peer's
  // life. Now it is recorded as `provider.errored` with `code: 'invariant'`
  // (which the store turns into a failure notification), and `run()` rejects
  // without recovering, because a fresh session is exactly what hides it.
  const r = rig(
    (h) =>
      h.sessionId === 'ses_aaaaaaaaaaaaaaaa'
        ? { contextTokens: 900, contextLimit: 1_000 }
        : { contextTokens: 100, contextLimit: 1_000 },
    { silentStop: true },
  )
  const orphanedTurn = 'trn_fedcba9876543210' as TurnId
  const orphanedId = 'qst_0123456789abcdef' as QuestionId
  const stub = stubPurge(r.provider, {
    // Asked on a turn of its own just before the stop, so the ask's own ending
    // is no evidence about it — exactly a provider that asks outside its turn.
    beforeStop: () => {
      r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push({
        type: 'question.asked',
        turnId: orphanedTurn,
        questionId: orphanedId,
        questions: [{ question: 'ship it?' }],
      })
    },
  })
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
  await until(() => r.feeds.has('ses_bbbbbbbbbbbbbbbb'), 'the replacement to subscribe')
  r.feeds.get('ses_bbbbbbbbbbbbbbbb')?.push(started(), ended())

  await assert.rejects(run, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'invariant')
    return true
  })

  const faults = r.records.filter((record) => record.type === 'provider.errored')
  assert.equal(faults.length, 1, 'the fault is recorded exactly once')
  const fault = faults[0]
  assert.equal(fault?.type === 'provider.errored' ? fault.data.code : undefined, 'invariant')
  assert.equal(fault?.type === 'provider.errored' ? fault.data.sessionId : undefined, 'ses_bbbbbbbbbbbbbbbb')
  assert.equal(fault?.type === 'provider.errored' ? fault.data.peerId : undefined, peerId)
  assert.equal(fault?.type === 'provider.errored' ? fault.data.providerId : undefined, 'claude')
  assert.equal(fault?.type === 'provider.errored' ? fault.data.retryable : undefined, false)
  assert.match(
    fault?.type === 'provider.errored' ? fault.data.message : '',
    new RegExp(orphanedId),
    'the record names the work that was inherited',
  )
  // What the wrapper wrote is still what the store accepts — including the fault,
  // which the store's `provider.errored` projection raises a failure for.
  assert.deepEqual(r.records.flatMap((record) => appendIssues(record)), [])
  // And no recovery: restarting is how the violation would disappear.
  assert.deepEqual(r.recovered, [])
  // The fault is not a dead session, so it is not recorded as one.
  assert.deepEqual(
    r.records.filter((record) => record.type === 'session.ended' && record.subject === 'ses_bbbbbbbbbbbbbbbb'),
    [],
  )
})

test('a turn still in flight at a turn boundary does not trigger a purge', async () => {
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stub = stubPurge(r.provider)
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: stub.purge,
    recover: r.recover,
  })

  const run = session.run()
  await until(() => r.feeds.has('ses_aaaaaaaaaaaaaaaa'), 'the stream to be subscribed')
  // Two turns open at once, each with its own id: a turn id is minted per turn
  // (§4), so the open set is keyed by it and must not collapse them into one.
  const secondTurn = 'trn_fedcba9876543210' as TurnId
  r.feeds
    .get('ses_aaaaaaaaaaaaaaaa')
    ?.push(started(), { type: 'turn.started', turnId: secondTurn, at: '2026-11-10T09:00:00.500Z' }, ended())
  await wait(50)
  assert.deepEqual(stub.calls, [], 'the first end is not a boundary while a turn is open')

  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push({
    type: 'turn.ended',
    turnId: secondTurn,
    at: '2026-11-10T09:00:01.500Z',
    reason: 'completed',
  })
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
    limits: { contextRatio: 0.8, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: async (record) => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 5))
      appended.push(record.type === 'peer.state_changed' ? record.data.state : record.type)
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

test('a compaction on the stream is one peer.compacted, priced when the profile prices it', async () => {
  // The window is asked for at compaction time, so the record carries the limit
  // this peer was configured with next to the tokens it compacted at — here, half
  // the window, which is the pair the notification reads as a verdict (§8).
  const r = rig(() => ({ contextTokens: 200_000, contextLimit: 400_000 }))
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.8, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => {
      r.records.push(record)
    },
    purge: async () => {
      throw new Error('must not purge')
    },
    recover: r.recover,
    estimateCompactionCost: (preTokens) => (preTokens / 1_000_000) * 3,
  })

  const run = session.run()
  r.feeds
    .get('ses_aaaaaaaaaaaaaaaa')
    ?.push(
      started(),
      { type: 'compaction', turnId, trigger: 'auto', contextTokensBefore: 200_000, contextTokensAfter: 12_000 },
      ended(),
      { type: 'session.ended', reason: 'exit', code: 0 },
    )
  await run

  const compacted = r.records.filter((record) => record.type === 'peer.compacted')
  assert.equal(compacted.length, 1, 'one compaction on the stream is one record, not one per turn')
  const record = compacted[0]
  assert.ok(record !== undefined && record.type === 'peer.compacted')
  assert.deepEqual(record.data, {
    peerId,
    trigger: 'auto',
    preTokens: 200_000,
    postTokens: 12_000,
    contextLimit: 400_000,
    estimatedCostUsd: 0.6,
  })
  // The same records the store is asked to append are the ones the registry validates.
  assert.deepEqual(r.records.flatMap((record) => appendIssues(record)), [])
})

test('a compaction between turns is recorded, and one with no price carries no cost', async () => {
  const r = rig(() => ({ contextTokens: 90_000, contextLimit: 200_000 }))
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.8, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
  // A person typed `/compact`: there is no turn open, and that is exactly the
  // compaction that would otherwise go unseen.
  r.feeds
    .get('ses_aaaaaaaaaaaaaaaa')
    ?.push(
      { type: 'compaction', trigger: 'manual', contextTokensBefore: 90_000 },
      { type: 'session.ended', reason: 'exit', code: 0 },
    )
  await run

  const compacted = r.records.filter((record) => record.type === 'peer.compacted')
  assert.equal(compacted.length, 1)
  const record = compacted[0]
  assert.ok(record !== undefined && record.type === 'peer.compacted')
  assert.deepEqual(record.data, { peerId, trigger: 'manual', preTokens: 90_000, contextLimit: 200_000 })
  assert.equal('estimatedCostUsd' in record.data, false, 'no price is not a price of zero')
})

test('the session hands off before the provider compacts, not after', async () => {
  // The model holds a million tokens but the CLI compacts at 200K. A ratio
  // against the configured window is at 18% here, so only the session's own
  // compaction point can fire — and it has to, because past it the provider
  // summarises the peer's context away and bills for the summarising (§8).
  const r = rig((h) =>
    h.sessionId === 'ses_aaaaaaaaaaaaaaaa'
      ? { contextTokens: 181_000, contextLimit: 1_000_000, autoCompactAt: 200_000 }
      : { contextTokens: 1_000, contextLimit: 1_000_000, autoCompactAt: 200_000 },
  )
  const stub = stubPurge(r.provider)
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.8, autoCompactRatio: 0.9, maxTurns: 10, maxSessionMillis: 60_000 },
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
  await until(() => stub.calls.length === 1, 'the purge to fire below the window')

  assert.deepEqual(stub.calls, [{ sessionId: 'ses_aaaaaaaaaaaaaaaa', asked: ['write your state file'] }])
  await until(() => r.feeds.has('ses_bbbbbbbbbbbbbbbb'), 'the fresh session to subscribe')
  r.feeds.get('ses_bbbbbbbbbbbbbbbb')?.push({ type: 'session.ended', reason: 'exit' })
  await run
})
