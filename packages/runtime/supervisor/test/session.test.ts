/**
 * The wrapper's job is the loop: map events, count turns, and stop the session
 * at the right boundary — including the hard part, asking a peer a question
 * while the answer only arrives on the stream the loop itself is reading.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fixedClock, type PeerId, type TurnId } from '@fleet/foundation-core'
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
}

const rig = (usage: (h: SessionHandle) => { contextTokens: number; contextLimit: number } = () => ({
  contextTokens: 100,
  contextLimit: 1_000,
})): Rig => {
  const feeds = new Map<string, Feed>()
  const sent: string[] = []
  const records: SessionRecord[] = []

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

  return { feeds, sent, records, provider }
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
    record: (record) => r.records.push(record),
    purge: async () => {
      throw new Error('must not purge')
    },
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
    record: (record) => r.records.push(record),
    purge: stub.purge,
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
    record: (record) => r.records.push(record),
    purge: async (input) => {
      // Resolved by the wrapper when the stream ends without an answer.
      await input.ask('write your state file')
      return { handle: handle('ses_bbbbbbbbbbbbbbbb'), stateFile, degraded: true, reason: 'the session ended first' }
    },
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

test('a purge that throws surfaces from run(), rather than leaving a peer that looks idle', async () => {
  const r = rig(() => ({ contextTokens: 900, contextLimit: 1_000 }))
  const stub = stubPurge(r.provider, { fail: new Error('restart failed') })
  const session = new PeerSession({
    provider: r.provider,
    handle: handle('ses_aaaaaaaaaaaaaaaa'),
    peerId,
    briefVersion: 1,
    limits: { contextRatio: 0.5, maxTurns: 10, maxSessionMillis: 60_000 },
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
    record: (record) => r.records.push(record),
    purge: stub.purge,
  })

  const run = session.run()
  await wait()
  r.feeds.get('ses_aaaaaaaaaaaaaaaa')?.push(started(), ended())

  await assert.rejects(run, /restart failed/)
})
