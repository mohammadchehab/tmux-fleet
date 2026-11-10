/**
 * The daemon's half of the session pump: what it hands `PeerSession`.
 *
 * The supervisor tests prove the wrapper purges at its limits. These prove the
 * *daemon* supplies those limits from the profile rather than from a copy of its
 * own — the failure this file exists for is a profile that says "hand off after
 * one turn" and a fleet that quietly waits forty, because the daemon kept a
 * frozen set of defaults and never asked.
 *
 * The provider is a fake all the way down: no process, no model, and a stream a
 * test pushes into. That is the daemon's dependency too — `Provider` is the
 * boundary — so nothing here reaches past what `compose.ts` would inject.
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixedClock, profilePaths, type PeerId, type Seq, type TurnId } from '@fleet/foundation-core'
import type { AppendEvent, EventSink, ProviderEvent, SessionSpec, Turn } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle } from '@fleet/runtime-provider-sdk'

import { decodeProfile, type Profile } from '../src/profile.ts'
import { createSupervisor, type Supervisor } from '../src/sessions.ts'

const peerId = 'engineer-1' as PeerId
const turnId = 'trn_0123456789abcdef' as TurnId

/** A stream a test pushes into, so no session ever waits on a real process. */
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

interface Rig {
  readonly supervisor: Supervisor
  /** Every record the daemon wrote to the store, in order. */
  readonly records: AppendEvent[]
  /** The specs the daemon started sessions from, so a purge's replacement is visible. */
  readonly starts: SessionSpec[]
}

/**
 * A provider whose `send` completes its own turn immediately: every delivery,
 * including the purge's ask, ends on the stream the wrapper is reading, which
 * is the only way a turn boundary is reached at all.
 */
const rig = async (profile: Profile): Promise<Rig> => {
  const records: AppendEvent[] = []
  const starts: SessionSpec[] = []
  const feeds = new Map<string, Feed>()

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
    start: async (spec: SessionSpec): Promise<SessionHandle> => {
      starts.push(spec)
      const sessionId = `ses_${String(starts.length).padStart(16, '0')}`
      feeds.set(sessionId, new Feed())
      return {
        sessionId,
        sessionRef: 'sess_x' as SessionHandle['sessionRef'],
        peerId: spec.peerId,
        providerId: 'claude',
        model: spec.model,
        permissionMode: spec.permissionMode,
        briefTurnId: turnId,
      }
    },
    events: (handle: SessionHandle) => {
      const feed = feeds.get(handle.sessionId)
      if (feed === undefined) throw new Error(`no stream for ${handle.sessionId}`)
      return feed
    },
    send: async (handle: SessionHandle, turn: Turn) => {
      feeds.get(handle.sessionId)?.push(
        { type: 'turn.started', turnId, at: '2026-11-10T09:00:00.000Z' },
        { type: 'turn.ended', turnId, at: '2026-11-10T09:00:01.000Z', reason: 'completed' },
      )
      void turn
      return turnId
    },
    // Small against a large window: no ratio can fire, so the only trigger a
    // test can observe is the turn count the profile asked for.
    usage: async () => ({ contextTokens: 1_000, contextLimit: 1_000_000 }),
    stop: async (handle: SessionHandle) => {
      const feed = feeds.get(handle.sessionId)
      feed?.push({ type: 'session.ended', reason: 'stopped' })
      feed?.close()
    },
  } as unknown as Provider

  // The sink only records: a projection is the store's business and is tested
  // there, and what this file asserts is what the daemon *passed down*.
  const store: EventSink = {
    append: async (batch: readonly AppendEvent[]): Promise<readonly Seq[]> => {
      records.push(...batch)
      return batch.map((_, index) => records.length - batch.length + index + 1)
    },
  }

  const supervisor = createSupervisor({
    profile,
    paths: profilePaths('test', { home: await mkdtemp(join(tmpdir(), 'fleet-sessions-')) }),
    store,
    providers: new Map([['claude', provider]]),
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
  })
  return { supervisor, records, starts }
}

const profileWith = (limits: Record<string, unknown> | undefined): Profile =>
  decodeProfile({
    profile: 'test',
    repos: ['acme/widgets'],
    peers: [{ id: peerId, role: 'engineer', provider: 'claude', model: 'claude-sonnet-5-5' }],
    ...(limits === undefined ? {} : { limits }),
  })

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (condition: () => boolean, what: string, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(5)
  }
}

/** Start the fleet, and deliver one turn through the daemon's own lease. */
const oneTurn = async (r: Rig): Promise<void> => {
  await r.supervisor.start()
  const lease = await r.supervisor.acquire(peerId)
  if (!lease.ok) throw lease.error
  await lease.value.send({ text: 'status?', kind: 'info', briefVersion: 1 })
}

test('the profile’s maxTurns is the session’s, so one turn can purge it', async (t) => {
  const r = await rig(profileWith({ purge: { maxTurns: 1 } }))
  t.after(() => r.supervisor.stop())
  await oneTurn(r)

  // `purge.started` is written before the state file is collected, so it is the
  // signal that the profile's threshold — not the default 40 — fired.
  await until(() => r.records.some((record) => record.type === 'purge.started'), 'the purge to start')
  assert.deepEqual(
    r.records.find((record) => record.type === 'purge.started')?.data,
    {
      peerId,
      sessionId: 'ses_0000000000000001',
      contextTokens: 1_000,
      contextLimit: 1_000_000,
    },
  )
  // One turn is under the default 40, so a daemon holding its own copy of the
  // thresholds would not have purged at all: the replacement session is the proof.
  await until(() => r.starts.length === 2, 'the replacement session')
})

test('a profile with no purge block leaves the supervisor’s defaults in place', async (t) => {
  const r = await rig(profileWith(undefined))
  t.after(() => r.supervisor.stop())
  await oneTurn(r)

  // The same turn that purged above must not purge here: 40 is the default, and
  // this test's job is to catch the daemon reintroducing a tighter second copy.
  await wait(100)
  assert.deepEqual(
    r.records.filter((record) => record.type.startsWith('purge.')),
    [],
  )
  assert.equal(r.starts.length, 1)
})
