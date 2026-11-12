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
import type { AppendEvent, EventSink, ProviderEvent, SessionSpec, Turn, Work, Worktree, WorktreeProvisioner } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle, TurnSpend } from '@fleet/runtime-provider-sdk'
import type { BookkeepingFailure } from '@fleet/runtime-supervisor'

import { decodeProfile, type Profile } from '../src/config/profile.ts'
import { toolPolicyFor } from '../src/config/tool-policy.ts'
import { createSupervisor, type Supervisor } from '../src/execution/sessions.ts'
import type { StandingBriefs } from '../src/execution/standards.ts'

const peerId = 'engineer-1' as PeerId
const checkout = '/work/widgets'
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
  readonly stateDir: string
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
const rig = async (
  profile: Profile,
  options: {
    readonly providerId?: string
    readonly worktrees?: readonly Worktree[]
    readonly provisioner?: WorktreeProvisioner
    readonly standing?: StandingBriefs
    /** What the provider reports a finished turn spent (§6.2); without one no usage row is written. */
    readonly spend?: TurnSpend
    /** The Works the store would project, for the Work a turn's usage is recorded against. */
    readonly work?: readonly Work[]
    /** Make the store refuse `turn.usage_recorded`, the way a locked or full ledger would. */
    readonly rejectUsage?: boolean
    /** Where the daemon reports a bookkeeping failure it did not turn into a session failure. */
    readonly onBookkeepingFailure?: (failure: BookkeepingFailure) => void
  } = {},
): Promise<Rig> => {
  const providerId = options.providerId ?? 'claude'
  const records: AppendEvent[] = []
  const starts: SessionSpec[] = []
  const feeds = new Map<string, Feed>()

  const provider = {
    id: providerId,
    capabilities: {
      resume: true,
      modelSwitch: true,
      usageTokens: true,
      usageCost: true,
      structuredOutput: true,
      permissionModes: ['default', 'plan'],
    },
    start: async (spec: SessionSpec): Promise<SessionHandle> => {
      starts.push(spec)
      const sessionId = `ses_${String(starts.length).padStart(16, '0')}`
      feeds.set(sessionId, new Feed())
      return {
        sessionId,
        sessionRef: 'sess_x' as SessionHandle['sessionRef'],
        peerId: spec.peerId,
        providerId,
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
    ...(options.spend === undefined ? {} : { turnSpend: () => options.spend }),
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
      // One row the store refuses, the way TASK-4's ledger would: the supervisor
      // has to keep the session and report the refusal rather than call it a crash.
      if (options.rejectUsage === true && batch.some((record) => record.type === 'turn.usage_recorded')) {
        throw new Error('the store refused the append')
      }
      records.push(...batch)
      return batch.map((_, index) => records.length - batch.length + index + 1)
    },
  }

  const paths = profilePaths('test', { home: await mkdtemp(join(tmpdir(), 'fleet-sessions-')) })
  const supervisor = createSupervisor({
    profile,
    paths,
    store,
    providers: new Map([[providerId, provider]]),
    // What the store would project: the rows a test seeded, plus every
    // `worktree.created` the supervisor itself appended.
    read: {
      work: { all: async () => options.work ?? [], get: async () => undefined },
      worktrees: {
        all: async () => [
          ...(options.worktrees ?? []),
          ...records.flatMap((record) =>
            record.type === 'worktree.created'
              ? [{ ...record.data, class: 'active', dirty: false, unpushed: false, holders: [] } as unknown as Worktree]
              : [],
          ),
        ],
      },
    },
    ...(options.provisioner === undefined ? {} : { worktrees: options.provisioner }),
    ...(options.standing === undefined ? {} : { standing: options.standing }),
    ...(options.onBookkeepingFailure === undefined
      ? {}
      : { onBookkeepingFailure: options.onBookkeepingFailure }),
    clock: fixedClock('2026-11-10T09:00:00.000Z'),
  })
  return { stateDir: paths.stateDir, supervisor, records, starts }
}

const profileWith = (limits: Record<string, unknown> | undefined): Profile =>
  decodeProfile({
    profile: 'test',
    repos: ['acme/widgets'],
    checkouts: { 'acme/widgets': checkout },
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

test('a lease taken before a purge names the session it will actually deliver into', async (t) => {
  const r = await rig(profileWith({ purge: { maxTurns: 1 } }))
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()

  // The Mailbox holds a lease across the purge: it takes one, a turn purges the
  // session, and the same lease sends the next message. `send` follows the pump
  // onto the replacement session, so `sessionId` has to follow it too — a frozen
  // one would have the store record the turn against the session that ended, and
  // `deliverTo`'s `deliveredSessionId` check would re-send every unacked message.
  const lease = await r.supervisor.acquire(peerId)
  if (!lease.ok) throw lease.error
  const first = lease.value.sessionId
  assert.equal(first, 'ses_0000000000000001')

  await lease.value.send({ text: 'status?', kind: 'info', briefVersion: 1 })
  await until(() => r.starts.length === 2, 'the replacement session')

  assert.equal(lease.value.sessionId, 'ses_0000000000000002')

  // A lease taken now agrees with the one held across the purge: both name the
  // session the log calls current.
  const fresh = await r.supervisor.acquire(peerId)
  if (!fresh.ok) throw fresh.error
  assert.equal(fresh.value.sessionId, lease.value.sessionId)
})

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

test('a usage row the store refuses reaches the daemon’s port, naming the peer, the turn and the error', async (t) => {
  // TASK-4 stopped a refused bookkeeping row from being read as a dead session.
  // The cost was silence: a fleet whose spend cap reads these rows had no way to
  // learn one was never filed. The port is the daemon's half of the answer — the
  // supervisor reports, the composition root logs, and the session stays live.
  const failures: BookkeepingFailure[] = []
  const r = await rig(profileWith(undefined), {
    spend: { inputTokens: 900, outputTokens: 120, cachedTokens: 0 },
    rejectUsage: true,
    onBookkeepingFailure: (failure) => failures.push(failure),
  })
  t.after(() => r.supervisor.stop())
  await oneTurn(r)

  await until(() => failures.length > 0, 'the daemon to be told the row was refused')
  assert.equal(failures.length, 1, 'one refused append is reported once')
  assert.equal(failures[0]?.peerId, peerId)
  assert.equal(failures[0]?.turnId, turnId)
  assert.equal((failures[0]?.error as Error).message, 'the store refused the append')

  // The peer is still running, and the store's version of the turn is a live
  // session that merely lacks its usage row — not a `peer.failed` the board rings on.
  assert.deepEqual(r.supervisor.running(), [peerId])
  assert.deepEqual(
    r.records.filter((record) => record.type === 'peer.failed' || record.type === 'turn.usage_recorded'),
    [],
  )
})

const twoPeers = (second: Record<string, unknown>, extra: Record<string, unknown> = {}): Profile =>
  decodeProfile({
    profile: 'test',
    repos: ['acme/widgets'],
    checkouts: { 'acme/widgets': checkout },
    peers: [
      { id: peerId, role: 'engineer', provider: 'claude', model: 'claude-sonnet-5-5' },
      { id: 'architect-1', role: 'architect', provider: 'claude', model: 'claude-sonnet-5-5', ...second },
    ],
    ...extra,
  })

/** A Work as the read model projects it: only the fields the supervisor reads are meaningful. */
const workRow = (workId: string, state: string, assignee: PeerId): Work =>
  ({ workId, state, assignee, title: 'a Work', dependsOn: [] }) as unknown as Work

const usageOf = (r: Rig): Record<string, unknown>[] =>
  r.records
    .filter((record) => record.type === 'turn.usage_recorded')
    .map((record) => record.data as Record<string, unknown>)

test('a turn’s usage is recorded against the Work the peer holds, so the per-Work cost view fills (TASK-78)', async (t) => {
  const WORK = 'wrk_7f3a91c2d84b0e56'
  const r = await rig(profileWith(undefined), {
    spend: { inputTokens: 900, outputTokens: 120, cachedTokens: 0 },
    work: [workRow(WORK, 'in_progress', peerId)],
  })
  t.after(() => r.supervisor.stop())
  await oneTurn(r)

  await until(() => usageOf(r).length > 0, 'the turn’s usage row')
  assert.equal(usageOf(r)[0]?.workId, WORK)
})

test('a turn with no held Work is recorded without one: a merged Work, or another peer’s, is not this peer’s', async (t) => {
  const r = await rig(profileWith(undefined), {
    spend: { inputTokens: 900, outputTokens: 120, cachedTokens: 0 },
    work: [
      workRow('wrk_0000000000000001', 'merged', peerId),
      workRow('wrk_0000000000000002', 'in_progress', 'architect-1' as PeerId),
    ],
  })
  t.after(() => r.supervisor.stop())
  await oneTurn(r)

  await until(() => usageOf(r).length > 0, 'the turn’s usage row')
  assert.equal(usageOf(r)[0]?.peerId, peerId)
  assert.equal(usageOf(r)[0]?.workId, undefined, 'the turn is still recorded, just not against a Work')
})

test('a peer’s session starts in its repo’s checkout, never the fleet’s state directory', async (t) => {
  const r = await rig(profileWith(undefined))
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()

  // `stateDir` holds the store, socket and transcripts. A peer whose cwd is
  // there sees none of the repo's AGENTS.md, CLAUDE.md or skills.
  assert.notEqual(r.starts[0]?.cwd, r.stateDir)
  assert.equal(r.starts[0]?.cwd, checkout)
})

test('a cursor peer starts in the checkout too, and read-only peers may share one', async (t) => {
  const profile = decodeProfile({
    profile: 'test',
    repos: ['acme/widgets'],
    checkouts: { 'acme/widgets': checkout },
    providers: { cursor: { contextLimits: { 'gpt-5': 200_000 } } },
    peers: [
      { id: 'cursor-1', role: 'reviewer', provider: 'cursor', model: 'gpt-5', permissionMode: 'plan' },
      { id: 'cursor-2', role: 'reviewer', provider: 'cursor', model: 'gpt-5', permissionMode: 'plan' },
    ],
  })
  const r = await rig(profile, { providerId: 'cursor' })
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()

  assert.deepEqual(r.starts.map((spec) => spec.cwd), [checkout, checkout])
  assert.notEqual(r.starts[0]?.cwd, r.stateDir)
})

test('a cursor peer whose role asks for an effort still starts exactly as it did, and the request rides the spec', async (t) => {
  // The daemon warns at `up` that this provider cannot honour the effort
  // (TASK-12), and then starts the peer anyway: the model and the read-only
  // mode are right, and a fleet that refused to start over a reasoning level
  // would be stricter than the profile's own author. What the spec carries is
  // the *request* — the cursor adapter never reads it.
  const profile = decodeProfile({
    profile: 'test',
    repos: ['acme/widgets'],
    checkouts: { 'acme/widgets': checkout },
    roles: { reviewer: { model: 'gpt-5', effort: 'high' } },
    providers: { cursor: { contextLimits: { 'gpt-5': 200_000 } } },
    peers: [{ id: 'reviewer-1', role: 'reviewer', provider: 'cursor', permissionMode: 'plan' }],
  })
  const r = await rig(profile, { providerId: 'cursor' })
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()

  const spec = r.starts[0]
  assert.equal(spec?.model, 'gpt-5', 'the model the role named, not one the daemon invented')
  assert.equal(spec?.effort, 'high')
  assert.equal(spec?.permissionMode, 'plan', 'cursor is read-only whatever the profile asks')
  assert.equal(spec?.cwd, checkout)
})

test('a peer’s own active worktree is preferred over the repo checkout', async (t) => {
  const worktree = {
    worktreeId: 'wt_0123456789abcdef',
    repo: 'acme/widgets',
    branch: 'feat/x',
    path: '/work/widgets/.claude/worktrees/x',
    ownerPeerId: peerId,
    class: 'active',
    dirty: false,
    unpushed: false,
    holders: [],
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
  } as unknown as Worktree
  const other = { ...worktree, worktreeId: 'wt_fedcba9876543210', path: '/elsewhere', ownerPeerId: 'architect-1' } as unknown as Worktree
  const r = await rig(profileWith(undefined), { worktrees: [other, { ...worktree, class: 'merged', path: '/old' } as Worktree, worktree] })
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()

  assert.equal(r.starts[0]?.cwd, worktree.path)
})

test('a second peer that can write is refused a checkout another already writes in', async (t) => {
  const r = await rig(twoPeers({}))
  t.after(() => r.supervisor.stop())

  await assert.rejects(r.supervisor.start(), (error: Error) => {
    assert.match(error.message, /architect-1.*engineer-1/s)
    assert.match(error.message, new RegExp(checkout))
    return true
  })
  assert.deepEqual(r.supervisor.running(), [peerId])
})

test('a read-only peer may share a checkout with a writer, in either order', async (t) => {
  const r = await rig(twoPeers({ permissionMode: 'plan' }))
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()
  assert.deepEqual(r.starts.map((spec) => spec.cwd), [checkout, checkout])
})

test('a peer with no worktree and no checkout is refused, not started in the state directory', async (t) => {
  const r = await rig(
    decodeProfile({
      profile: 'test',
      repos: ['acme/widgets'],
      peers: [{ id: peerId, role: 'engineer', provider: 'claude', model: 'claude-sonnet-5-5' }],
    }),
  )
  t.after(() => r.supervisor.stop())

  await assert.rejects(r.supervisor.start(), /no worktree and no checkout.*checkouts\.acme\/widgets/s)
  assert.equal(r.starts.length, 0)
})

test('a purge restart asks for the working directory again', async (t) => {
  const rows: Worktree[] = []
  const r = await rig(profileWith({ purge: { maxTurns: 1 } }), { worktrees: rows })
  t.after(() => r.supervisor.stop())
  rows.push({
    worktreeId: 'wt_0123456789abcdef',
    repo: 'acme/widgets',
    branch: 'feat/x',
    path: '/work/widgets/.claude/worktrees/x',
    ownerPeerId: peerId,
    class: 'active',
    dirty: false,
    unpushed: false,
    holders: [],
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
  } as unknown as Worktree)
  await r.supervisor.start()
  assert.equal(r.starts[0]?.cwd, rows[0]?.path)
  rows.length = 0
  const lease = await r.supervisor.acquire(peerId)
  if (!lease.ok) throw lease.error
  await lease.value.send({ text: 'status?', kind: 'info', briefVersion: 1 })
  await until(() => r.starts.length === 2, 'the replacement session')

  assert.equal(r.starts[1]?.cwd, checkout)
})

test('a checkout for a repo the profile does not list is refused at load', () => {
  assert.throws(
    () => twoPeers({ permissionMode: 'plan' }, { checkouts: { 'acme/other': '/work/other' } }),
    /acme\/other.*not in repos/s,
  )
  assert.throws(() => twoPeers({}, { checkouts: { 'acme/widgets': 'relative/path' } }))
})

/** A provisioner that records what it was asked and makes `<root>/.claude/worktrees/<topic>` up. */
const fakeProvisioner = (): { provisioner: WorktreeProvisioner; asked: { root: string; topic: string; branch: string }[] } => {
  const asked: { root: string; topic: string; branch: string }[] = []
  const known = new Set<string>()
  return {
    asked,
    provisioner: {
      ensure: async ({ root, topic, branch }) => {
        asked.push({ root, topic, branch })
        const path = `${root}/.claude/worktrees/${topic}`
        const created = !known.has(path)
        known.add(path)
        return { path, created }
      },
    },
  }
}

test('two writing peers each get their own worktree under the checkout, so neither is refused', async (t) => {
  const { provisioner, asked } = fakeProvisioner()
  const r = await rig(twoPeers({}), { provisioner })
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()

  assert.deepEqual(r.starts.map((spec) => spec.cwd), [
    `${checkout}/.claude/worktrees/peer-engineer-1`,
    `${checkout}/.claude/worktrees/peer-architect-1`,
  ])
  assert.deepEqual(asked.map((ask) => ask.branch), ['peer/engineer-1', 'peer/architect-1'])
  // Owner recorded at creation, as an event (§9), so the next start finds it.
  const created = r.records.filter((record) => record.type === 'worktree.created')
  assert.deepEqual(
    created.map((record) => ({ owner: record.data.ownerPeerId, path: record.data.path, repo: record.data.repo, class: record.data.class })),
    [
      { owner: 'engineer-1', path: `${checkout}/.claude/worktrees/peer-engineer-1`, repo: 'acme/widgets', class: 'active' },
      { owner: 'architect-1', path: `${checkout}/.claude/worktrees/peer-architect-1`, repo: 'acme/widgets', class: 'active' },
    ],
  )
})

test('a read-only peer keeps the shared checkout and is never given a worktree', async (t) => {
  const { provisioner, asked } = fakeProvisioner()
  const r = await rig(twoPeers({ permissionMode: 'plan' }), { provisioner })
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()

  assert.equal(r.starts[1]?.cwd, checkout)
  assert.deepEqual(asked.map((ask) => ask.topic), ['peer-engineer-1'])
})

test('a peer that already owns an active worktree is not given a second one, across a purge restart', async (t) => {
  const { provisioner, asked } = fakeProvisioner()
  const r = await rig(profileWith({ purge: { maxTurns: 1 } }), { provisioner })
  t.after(() => r.supervisor.stop())
  await oneTurn(r)
  await until(() => r.starts.length === 2, 'the replacement session')

  assert.equal(asked.length, 1, 'the restart found the row the first start wrote')
  assert.equal(r.records.filter((record) => record.type === 'worktree.created').length, 1)
  assert.equal(r.starts[1]?.cwd, r.starts[0]?.cwd)
})

test('a provisioner that cannot make the worktree refuses the peer, not falls back to a shared checkout', async (t) => {
  const r = await rig(profileWith(undefined), {
    provisioner: { ensure: async () => Promise.reject(new Error('git refused to make the worktree')) },
  })
  t.after(() => r.supervisor.stop())

  await assert.rejects(r.supervisor.start(), /git refused to make the worktree/)
  assert.equal(r.starts.length, 0)
})

/** A standing brief whose version a test can move, recording where it was asked to read from. */
const fakeStanding = (): { standing: StandingBriefs; asked: { peer: string; cwd: string }[]; setText(text: string): void } => {
  const asked: { peer: string; cwd: string }[] = []
  let text = 'Never push to main.'
  return {
    asked,
    setText: (next) => (text = next),
    standing: {
      for: async (peer, cwd) => {
        asked.push({ peer: String(peer.id), cwd })
        return {
          brief: {
            briefId: 'brf_00000000000000b7' as never,
            version: 7,
            contractVersions: [],
            text: `You are ${String(peer.id)}. Your standing instructions are given.`,
          },
          systemPromptAppend: text,
        }
      },
    },
  }
}

test('the session starts on the standing brief and carries the standards as its standing instructions, claude and cursor alike', async (t) => {
  for (const providerId of ['claude', 'cursor']) {
    const { standing, asked } = fakeStanding()
    const profile = decodeProfile({
      profile: 'test',
      repos: ['acme/widgets'],
      checkouts: { 'acme/widgets': checkout },
      ...(providerId === 'cursor' ? { providers: { cursor: { contextLimits: { m: 200_000 } } } } : {}),
      peers: [{ id: peerId, role: 'engineer', provider: providerId, model: 'm', ...(providerId === 'cursor' ? { permissionMode: 'plan' } : {}) }],
    })
    const r = await rig(profile, { providerId, standing })
    t.after(() => r.supervisor.stop())
    await r.supervisor.start()

    assert.equal(r.starts[0]?.brief.version, 7, providerId)
    assert.equal(r.starts[0]?.systemPromptAppend, 'Never push to main.', providerId)
    // Read from where the peer works, so the repo is the peer's own.
    assert.deepEqual(asked, [{ peer: String(peerId), cwd: checkout }])
    // The Mailbox judges mail against the version the running session carries.
    assert.equal(await r.supervisor.briefs.current(peerId), 7, providerId)
  }
})

test('a purge restart reuses the brief and the standards it started on, even if they have changed since (§8: the same brief)', async (t) => {
  const { standing, asked, setText } = fakeStanding()
  const r = await rig(profileWith({ purge: { maxTurns: 1 } }), { standing })
  t.after(() => r.supervisor.stop())
  await oneTurn(r)
  setText('Rules edited while the peer was running.')
  await until(() => r.starts.length === 2, 'the replacement session')

  assert.equal(r.starts[1]?.brief.briefId, r.starts[0]?.brief.briefId)
  assert.equal(r.starts[1]?.systemPromptAppend, 'Never push to main.')
  assert.equal(asked.length, 1, 'standards are read at a start, not at every restart')
})

test('a peer whose standards cannot be built is refused, with the reason, and no session is started', async (t) => {
  const r = await rig(profileWith(undefined), {
    standing: {
      for: async () => Promise.reject(new Error('standards.nonNegotiables names /p/n.md, which cannot be read')),
    },
  })
  t.after(() => r.supervisor.stop())

  await assert.rejects(r.supervisor.start(), /standards\.nonNegotiables names \/p\/n\.md/)
  assert.equal(r.starts.length, 0)
})

test('a peer refused at start is a peer.failed the board shows, the other peers still start, and `up` still fails (§4)', async (t) => {
  const r = await rig(
    decodeProfile({
      profile: 'test',
      repos: ['acme/widgets'],
      checkouts: { 'acme/widgets': checkout },
      peers: [
        { id: 'architect-1', role: 'architect', provider: 'claude', model: 'm', permissionMode: 'plan' },
        { id: peerId, role: 'engineer', provider: 'claude', model: 'm' },
        { id: 'engineer-2', role: 'engineer', provider: 'claude', model: 'm', permissionMode: 'plan' },
      ],
    }),
    {
      standing: {
        for: async (peer) =>
          String(peer.id) === 'engineer-1'
            ? Promise.reject(new Error('standards.nonNegotiables names /p/n.md, which cannot be read'))
            : { brief: { briefId: 'brf_00000000000000b7' as never, version: 1, contractVersions: [], text: 'ok' } },
      },
    },
  )
  t.after(() => r.supervisor.stop())

  await assert.rejects(r.supervisor.start(), /standards\.nonNegotiables names \/p\/n\.md/)

  assert.deepEqual(r.supervisor.running().map(String).sort(), ['architect-1', 'engineer-2'], 'the peers after it were still started')
  const failed = r.records.filter((record) => record.type === 'peer.failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.subject, 'engineer-1')
  assert.equal(failed[0]?.actor, 'peer:engineer-1')
  assert.deepEqual(failed[0]?.data, {
    peerId: 'engineer-1',
    reason: 'provider_error',
    message: 'standards.nonNegotiables names /p/n.md, which cannot be read',
    retryable: false,
  })
})

const toolPolicyProfile = (block: Record<string, unknown> | undefined): Profile =>
  decodeProfile({
    profile: 'test',
    repos: ['acme/widgets'],
    checkouts: { 'acme/widgets': checkout },
    ...(block === undefined ? {} : { toolPolicy: block }),
    peers: [{ id: peerId, role: 'engineer', provider: 'claude', model: 'claude-opus-5-5' }],
  })

test('a peer starts with the routine tool policy, so routine reads and git inspection do not ask (TASK-119)', async (t) => {
  const r = await rig(toolPolicyProfile(undefined))
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()

  assert.deepEqual(r.starts[0]?.toolPolicy, toolPolicyFor(undefined, checkout))
  assert.equal(r.starts[0]?.toolPolicy?.defaultAction, 'ask')
})

test('a profile that asks for ask-all starts the peer with no tool policy at all (TASK-119)', async (t) => {
  const r = await rig(toolPolicyProfile({ preset: 'ask-all' }))
  t.after(() => r.supervisor.stop())
  await r.supervisor.start()

  assert.equal(r.starts[0]?.toolPolicy, undefined)
})
