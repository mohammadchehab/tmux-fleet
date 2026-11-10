/**
 * `tracker-sync` (§3, §6): the board as a source and a sink.
 *
 * The tracker here is a fake the test drives by hand, because the port is what
 * this body is written against — that `backlog` maps it onto a CLI is the
 * adapter's test, and the two meet at `Tracker`. What this file pins is the part
 * the fleet's own log depends on:
 *
 * - a pull proposes only the keys no Work names, so a heartbeat every five
 *   minutes does not mint the same Work twice;
 * - the card is read with `get` before it is proposed, so the Work carries the
 *   ticket as it is now, not as the list summarised it;
 * - a sink event moves exactly the one card it is about, and `review_requested`
 *   links the PR that event names;
 * - a store that refuses the batch throws (the run failed), while a board that
 *   refuses one card is counted and recorded — nine other cards are not lies.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse, peerId, type PeerId, type Repo, type Sha } from '@fleet/foundation-core'
import {
  eventSchemaFor,
  type AppendEvent,
  type ExternalItem,
  type FleetEvent,
  type Tracker,
  type Work,
  type WorkId,
} from '@fleet/foundation-contracts'
import type { RoutineContext } from '../src/routine.ts'
import { sync, workIdFor, type TrackerSyncDeps } from '../src/routines/tracker-sync.ts'
import { AT, fakeRead, fakeStore, movableClock } from './support/fakes.ts'

const REPO = 'acme/widgets' as Repo
const PEER: PeerId = parse(peerId(), 'engineer-1')
const SHA: Sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' as Sha

/** A board the test edits directly: what it returns, and what was asked of it. */
interface FakeTracker extends Tracker {
  /** What `pull` returns next. */
  items: readonly ExternalItem[]
  /** What `get` returns for a key; `undefined` means "not there". */
  cards: Map<string, ExternalItem>
  readonly pulled: string[]
  readonly got: string[]
  readonly transitions: { key: string; to: string }[]
  readonly links: { key: string; url: string }[]
  readonly comments: { key: string; body: string }[]
  /** Make `pull` throw, for a board the daemon could not reach. */
  failPull(): void
  /** Make the next write for one key throw, so a single card is refused. */
  refuse(key: string): void
}

const item = (key: string, fields: Partial<ExternalItem> = {}): ExternalItem => ({
  system: 'backlog',
  key,
  title: `Ticket ${key}`,
  status: 'To Do',
  ...fields,
})

const fakeTracker = (items: readonly ExternalItem[] = []): FakeTracker => {
  const cards = new Map(items.map((card) => [card.key, card]))
  const pulled: string[] = []
  const got: string[] = []
  const transitions: { key: string; to: string }[] = []
  const links: { key: string; url: string }[] = []
  const comments: { key: string; body: string }[] = []
  const refused = new Set<string>()
  let pullFails = false

  return {
    items,
    cards,
    pulled,
    got,
    transitions,
    links,
    comments,
    failPull: () => {
      pullFails = true
    },
    refuse: (key) => refused.add(key),
    pull: async (query) => {
      pulled.push(query)
      if (pullFails) throw new Error('the board is unreachable')
      return items
    },
    get: async (key) => {
      got.push(key)
      return cards.get(key)
    },
    transition: async (key, to) => {
      if (refused.has(key)) throw new Error(`${key} is locked`)
      transitions.push({ key, to })
    },
    link: async (key, url) => {
      if (refused.has(key)) throw new Error(`${key} is locked`)
      links.push({ key, url })
    },
    comment: async (key, body) => {
      if (refused.has(key)) throw new Error(`${key} is locked`)
      comments.push({ key, body })
    },
  }
}

/** A Work the log already holds, as the projection would render it. */
const work = (key: string, fields: Partial<Work> = {}): Work => ({
  workId: workIdFor('backlog', key),
  title: `Ticket ${key}`,
  state: 'assigned',
  dependsOn: [],
  prs: [],
  external: { system: 'backlog', key },
  createdAt: AT,
  updatedAt: AT,
  ...fields,
})

const depsOf = (tracker: Tracker, works: readonly Work[] = []): TrackerSyncDeps & { store: ReturnType<typeof fakeStore> } => ({
  read: fakeRead({ work: works }),
  tracker,
  store: fakeStore(),
  system: 'backlog',
  query: 'To Do,In Progress',
})

const contextOf = (event?: FleetEvent): RoutineContext => ({
  routineId: 'tracker-sync',
  kind: 'tracker-sync',
  trigger: event === undefined ? 'heartbeat' : 'event',
  at: AT,
  ...(event === undefined ? {} : { event }),
  clock: movableClock(),
})

const appended = (store: ReturnType<typeof fakeStore>, type: AppendEvent['type']): readonly AppendEvent[] =>
  store.appended.filter((event) => event.type === type)

describe('the pull half: a heartbeat asks the board what it has', () => {
  it('proposes one Work per unseen card, read with get', async () => {
    const tracker = fakeTracker([item('TASK-1'), item('TASK-2')])
    const deps = depsOf(tracker)

    await sync(deps, contextOf())

    assert.deepEqual(tracker.pulled, ['To Do,In Progress'])
    assert.deepEqual(tracker.got, ['TASK-1', 'TASK-2'])
    const proposed = appended(deps.store, 'work.proposed')
    assert.equal(proposed.length, 2)
    assert.deepEqual(
      proposed.map((event) => event.type === 'work.proposed' && event.data.external?.key),
      ['TASK-1', 'TASK-2'],
    )
  })

  it('leaves alone every key a Work already names, by system and key', async () => {
    const tracker = fakeTracker([item('TASK-1'), item('TASK-2')])
    // A Work from a *different* board with the same key is a different ticket.
    const deps = depsOf(tracker, [
      work('TASK-1'),
      work('TASK-9', { external: { system: 'jira', key: 'TASK-2' } }),
    ])

    await sync(deps, contextOf())

    assert.deepEqual(tracker.got, ['TASK-2'])
    assert.equal(appended(deps.store, 'work.proposed').length, 1)
  })

  it('proposes the card read with get, not the list row', async () => {
    const tracker = fakeTracker([item('TASK-1', { title: 'List summary' })])
    tracker.cards.set(
      'TASK-1',
      item('TASK-1', {
        title: 'The whole\nticket',
        body: 'Everything a human wrote.',
        url: 'https://board.example/TASK-1',
      }),
    )
    const deps = depsOf(tracker)

    await sync(deps, contextOf())

    const proposed = appended(deps.store, 'work.proposed')
    assert.equal(proposed.length, 1)
    const first = proposed[0]
    assert.ok(first !== undefined && first.type === 'work.proposed')
    assert.equal(first.data.title, 'The whole ticket', 'the title is one line, as work.proposed requires')
    assert.equal(first.data.body, 'Everything a human wrote.')
    assert.deepEqual(first.data.external, {
      system: 'backlog',
      key: 'TASK-1',
      url: 'https://board.example/TASK-1',
    })
    assert.equal(first.subject, workIdFor('backlog', 'TASK-1'))
  })

  it('derives the Work id from the card, so the same ticket is the same Work', async () => {
    const tracker = fakeTracker([item('TASK-1')])
    const first = depsOf(tracker)
    await sync(first, contextOf())
    const again = depsOf(tracker)
    await sync(again, contextOf())

    const idOf = (batch: readonly AppendEvent[]): unknown => batch[0]?.type === 'work.proposed' && batch[0].subject
    assert.deepEqual(idOf(first.store.appended), idOf(again.store.appended))
  })

  it('a card listed and already gone is one failed action, not a proposal', async () => {
    const tracker = fakeTracker([item('TASK-1'), item('TASK-2')])
    tracker.cards.delete('TASK-1')
    const deps = depsOf(tracker)

    const outcome = await sync(deps, contextOf())

    assert.equal(appended(deps.store, 'work.proposed').length, 1)
    assert.equal(outcome.actionsFailed, 1)
    const record = appended(deps.store, 'tracker.synced')[0]
    assert.ok(record !== undefined && record.type === 'tracker.synced')
    assert.equal(record.data.pulled, 2)
    assert.equal(record.data.proposed, 1)
    assert.equal(record.data.failed, 1)
    assert.match(String(record.data.error), /TASK-1/)
  })

  it('a board that cannot be read throws, so the run is recorded as failed', async () => {
    const tracker = fakeTracker()
    tracker.failPull()
    const deps = depsOf(tracker)

    await assert.rejects(() => sync(deps, contextOf()), /unreachable/)
    assert.equal(deps.store.appended.length, 0, 'a pull that did not happen must not record tracker.synced')
  })

  it('records the run even when the board has nothing new', async () => {
    const deps = depsOf(fakeTracker([]))

    const outcome = await sync(deps, contextOf())

    assert.equal(outcome.actions, 0)
    assert.equal(outcome.actionsFailed, 0)
    const record = appended(deps.store, 'tracker.synced')[0]
    assert.ok(record !== undefined && record.type === 'tracker.synced')
    assert.deepEqual(
      { pulled: record.data.pulled, proposed: record.data.proposed, query: record.data.query },
      { pulled: 0, proposed: 0, query: 'To Do,In Progress' },
    )
  })
})

/**
 * The events a sink can be woken by, as the log would hand them over:
 * decoded through the registry, so a test cannot state a payload the store
 * would have refused.
 */
const asLogged = (type: FleetEvent['type'], subject: WorkId, data: Record<string, unknown>, seq = 1): FleetEvent => {
  const schema = eventSchemaFor(type)
  assert.ok(schema !== undefined, `no schema for ${type}`)
  return parse(schema, { seq, type, ts: AT, subject, actor: 'scheduler', data })
}

const started = (target: Work, seq = 1): FleetEvent =>
  asLogged('work.started', target.workId, { workId: target.workId, peerId: PEER }, seq)

const reviewRequested = (target: Work, number: number, seq = 1): FleetEvent =>
  asLogged('work.review_requested', target.workId, { workId: target.workId, peerId: PEER, pr: { repo: REPO, number } }, seq)

const noted = (target: Work, phase: string, body: string, seq = 1): FleetEvent =>
  asLogged('work.noted', target.workId, { workId: target.workId, peerId: PEER, phase, body }, seq)

const merged = (target: Work, number: number, headSha: string, seq = 1): FleetEvent =>
  asLogged(
    'work.merged',
    target.workId,
    { workId: target.workId, pr: { repo: REPO, number }, headSha },
    seq,
  )

describe('the sink half: a work event moves the one card it is about', () => {
  it('work.started moves the card to in progress, and pulls nothing', async () => {
    const tracker = fakeTracker([item('TASK-1')])
    const target = work('TASK-1')
    const deps = depsOf(tracker, [target])

    await sync(deps, contextOf(started(target)))

    assert.deepEqual(tracker.pulled, [], 'a sink event is not a reason to read the board')
    assert.deepEqual(tracker.transitions, [{ key: 'TASK-1', to: 'in_progress' }])
    assert.deepEqual(tracker.links, [])
  })

  it('work.review_requested moves the card and links the PR the event names', async () => {
    const tracker = fakeTracker([item('TASK-1')])
    const target = work('TASK-1')
    const deps = depsOf(tracker, [target])

    await sync(deps, contextOf(reviewRequested(target, 7)))

    assert.deepEqual(tracker.transitions, [{ key: 'TASK-1', to: 'in_review' }])
    assert.deepEqual(tracker.links, [{ key: 'TASK-1', url: 'https://github.com/acme/widgets/pull/7' }])
  })

  it('work.merged moves the card to merged and links nothing', async () => {
    const tracker = fakeTracker([item('TASK-1')])
    const target = work('TASK-1')
    const deps = depsOf(tracker, [target])

    await sync(deps, contextOf(merged(target, 7, SHA)))

    assert.deepEqual(tracker.transitions, [{ key: 'TASK-1', to: 'merged' }])
    assert.deepEqual(tracker.links, [])
  })

  it('work.noted comments on the card instead of moving it, and the phase is in the words', async () => {
    const tracker = fakeTracker([item('TASK-1')])
    const target = work('TASK-1')
    const deps = depsOf(tracker, [target])

    await sync(deps, contextOf(noted(target, 'implement', 'the checks verdict is pinned to the head sha')))

    assert.deepEqual(tracker.pulled, [], 'a note is not a reason to read the board')
    assert.deepEqual(tracker.transitions, [], 'a note is not a column')
    assert.deepEqual(tracker.comments, [
      { key: 'TASK-1', body: `${PEER} (implement): the checks verdict is pinned to the head sha` },
    ])
  })

  it('a blocked note reaches the board as a comment and the PM as a question, not as a column', async () => {
    const tracker = fakeTracker([item('TASK-1')])
    const target = work('TASK-1')
    const deps = depsOf(tracker, [target])

    const outcome = await sync(deps, contextOf(noted(target, 'blocked', 'nothing can replay a partial log')))

    assert.deepEqual(tracker.transitions, [])
    assert.deepEqual(tracker.comments.map((comment) => comment.body), [
      `${PEER} (blocked): nothing can replay a partial log`,
    ])
    assert.equal(outcome.actions, 1)
    assert.equal(outcome.actionsFailed, 0)
    const record = appended(deps.store, 'tracker.synced')[0]
    assert.ok(record !== undefined && record.type === 'tracker.synced')
    assert.equal(record.data.commented, 1)
    assert.equal(record.data.transitioned, 0)
  })

  it('a card that refuses the note is counted like any other refused write', async () => {
    const tracker = fakeTracker()
    tracker.refuse('TASK-2')
    const target = work('TASK-2')
    const deps = depsOf(tracker, [target])

    const outcome = await sync(deps, contextOf(noted(target, 'mr', 'opened #7')))

    assert.equal(outcome.actions, 0)
    assert.equal(outcome.actionsFailed, 1)
    const record = appended(deps.store, 'tracker.synced')[0]
    assert.ok(record !== undefined && record.type === 'tracker.synced')
    assert.equal(record.data.commented, 0)
    assert.match(String(record.data.error), /locked/)
  })

  it('a Work with no external is not a sink, and a Work the log does not hold moves nothing', async () => {
    const tracker = fakeTracker([item('TASK-1')])
    const internal: Work = {
      workId: 'wrk_0000000000000001' as WorkId,
      title: 'internal',
      state: 'assigned',
      dependsOn: [],
      prs: [],
      createdAt: AT,
      updatedAt: AT,
    }
    const deps = depsOf(tracker, [internal])

    const outcome = await sync(deps, contextOf(started(internal)))
    const absent: Work = { ...internal, workId: 'wrk_00000000000000ff' as WorkId }
    await sync(deps, contextOf(started(absent)))

    assert.deepEqual(tracker.transitions, [])
    assert.equal(outcome.actions, 0)
  })

  it('a card the board refuses is counted and recorded, and the run says so', async () => {
    const tracker = fakeTracker()
    tracker.refuse('TASK-2')
    const target = work('TASK-2')
    const deps = depsOf(tracker, [target])

    const outcome = await sync(deps, contextOf(started(target)))

    assert.deepEqual(tracker.transitions, [])
    assert.equal(outcome.actions, 0)
    assert.equal(outcome.actionsFailed, 1)
    const record = appended(deps.store, 'tracker.synced')[0]
    assert.ok(record !== undefined && record.type === 'tracker.synced')
    assert.equal(record.data.transitioned, 0)
    assert.equal(record.data.failed, 1)
    assert.match(String(record.data.error), /locked/)
  })

  it('hashes what it read, so a replay can tell a changed decision from a changed board', async () => {
    const context = contextOf()

    const first = await sync(depsOf(fakeTracker([item('TASK-1')])), context)
    const same = await sync(depsOf(fakeTracker([item('TASK-1')])), context)
    const more = await sync(depsOf(fakeTracker([item('TASK-1'), item('TASK-2')])), context)

    assert.equal(first.inputsHash, same.inputsHash)
    assert.notEqual(first.inputsHash, more.inputsHash)
  })
})
