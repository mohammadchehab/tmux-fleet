/**
 * The `backlog` adapter against the real CLI, in a real project on disk.
 *
 * The package's own suite injects a runner, deliberately: no binary, no project,
 * no process. What it cannot prove is the other half — that the argv this adapter
 * builds is argv `backlog` accepts, that the board it edits is the board the
 * human opens, and that the JSON the CLI really prints is the JSON `observe.ts`
 * reads. That is this file. Every call goes through the production
 * `execFileBacklog` in a project `backlog init` created, and each assertion reads
 * the card back through the CLI rather than through the adapter that wrote it,
 * so a wrong write cannot agree with itself.
 *
 * The second half of the file drives `tracker-sync` itself: a real event store,
 * the real routing of events to the board, and the adapter underneath — the
 * three only prove they fit when they run together. The forge is the one stand-in
 * (`support/fake-forge.ts`), because the PR a card is linked to should be a row a
 * `PullRequests` port reported, not a number the test invented.
 *
 * Skipped when `backlog` is not on `PATH` — CI has no binary. The project lives
 * outside the repo and is removed on teardown, so `git status` stays clean.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { Clock, PeerId, Repo, Sha, Timestamp } from '../../../packages/foundation/core/src/index.ts'
import type {
  AppendEvent,
  FleetEvent,
  Tracker,
} from '../../../packages/foundation/contracts/src/index.ts'
import { openSqliteStore, type EventStore } from '../../../packages/foundation/store/src/index.ts'
import { sync, type RoutineContext } from '../../../packages/orchestration/routines/src/index.ts'
// The body's own deps, which the package's barrel does not re-export: the daemon
// narrows them to what it wires, and this test hands the body what it asks for.
import type { TrackerSyncDeps } from '../../../packages/orchestration/routines/src/routines/tracker-sync.ts'
import { createBacklogTracker, execFileBacklog } from '../../../packages/integrations/trackers/backlog/src/index.ts'
import { createFakeForge } from '../support/fake-forge.ts'

const probe = await execFileBacklog(['--version'], { cwd: tmpdir() })
const installed = probe.code === 0

/** The card as the CLI has it on disk, independent of the adapter under test. */
const readCard = async (project: string, key: string): Promise<Record<string, unknown>> => {
  const result = await execFileBacklog(['task', 'view', key, '--json'], { cwd: project })
  assert.equal(result.code, 0, `backlog task view ${key} exited ${String(result.code)}: ${result.stderr}`)
  const parsed = JSON.parse(result.stdout) as { task?: Record<string, unknown> }
  assert.ok(parsed.task, `backlog task view ${key} printed no task`)
  return parsed.task
}

describe('the backlog adapter over the real CLI', { skip: installed ? false : 'backlog is not on PATH' }, () => {
  let project: string
  let tracker: Tracker

  before(async () => {
    project = await mkdtemp(join(tmpdir(), 'fleet-backlog-e2e-'))
    for (const args of [
      ['init', 'demo', '--agent-instructions', 'none', '--no-git'],
      ['task', 'create', 'First card', '--plain'],
      ['task', 'create', 'Second card', '--plain'],
    ] as const) {
      const result = await execFileBacklog(args, { cwd: project })
      assert.equal(result.code, 0, `backlog ${args.join(' ')} exited ${String(result.code)}: ${result.stderr}`)
    }
    tracker = createBacklogTracker({
      path: project,
      // One column mapped, one deliberately not: the unmapped half is what the transition test pins.
      statuses: { in_progress: 'In Progress' },
    })
  })

  after(async () => {
    await rm(project, { recursive: true, force: true })
  })

  it('pulls the columns the profile names, and every column when it names none', async () => {
    const open = await tracker.pull('To Do')
    assert.deepEqual(
      open.map((item) => item.key),
      ['TASK-1', 'TASK-2'],
    )
    const [first] = open
    assert.equal(first?.title, 'First card')
    assert.equal(first?.status, 'To Do')
    assert.equal(first?.system, 'backlog')
    // A list row carries no `path` and no `description`; the pull reads each card with `task view` to get
    // them, so an item always has the link a brief needs. Pinned because it is invisible in the package
    // suite, whose fixtures are the only copy of the CLI's JSON that a runner has.
    assert.match(first?.url ?? '', /^backlog\/tasks\/task-1 - .*\.md$/)
    assert.equal(first?.body, undefined, 'the first card was created without a body')

    // The filter is the board's own status, so a column nobody is in reads as an empty board, not an error.
    assert.deepEqual(await tracker.pull('Done'), [])
  })

  it('gets one card, and a card that is not on this board is undefined rather than a failure', async () => {
    const card = await tracker.get('TASK-1')
    assert.equal(card?.title, 'First card')
    // No `urlBase` in this profile, so the URL is the card's path — the thing a human opens.
    assert.match(card?.url ?? '', /^backlog\/tasks\/task-1 - .*\.md$/)
    // Never edited: the CLI reports `updatedAt: null`, so the read is stamped with the moment it happened.
    assert.match(card?.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)
    assert.equal(card?.body, undefined)

    assert.equal(await tracker.get('TASK-404'), undefined)
  })

  it('transitions into the column the profile maps, and leaves the board alone for a state it does not', async () => {
    await tracker.transition('TASK-2', 'in_progress')
    assert.equal((await readCard(project, 'TASK-2')).status, 'In Progress')
    // Read back through the port too: the card now answers the column the profile asked for.
    assert.deepEqual(
      (await tracker.pull('In Progress')).map((item) => item.key),
      ['TASK-2'],
    )

    // `merged` has no column in this profile: inventing one would rewrite a board the fleet was never told about.
    await tracker.transition('TASK-1', 'merged')
    assert.equal((await readCard(project, 'TASK-1')).status, 'To Do')
  })

  it('links the PR once, however many times tracker-sync sees the same review request', async () => {
    const url = 'https://github.com/o/r/pull/9'
    await tracker.link('TASK-1', url)
    await tracker.link('TASK-1', url)

    const notes = String((await readCard(project, 'TASK-1')).implementationNotes ?? '')
    assert.equal(notes.split(url).length - 1, 1, `the PR was written ${String(notes.split(url).length - 1)} times`)

    // And it survives a fresh read through the port, which is what the next wake sees.
    const card = await tracker.get('TASK-1')
    assert.equal(card?.title, 'First card')
  })

  it('refuses to link a card that is not there, rather than writing a note nowhere', async () => {
    await assert.rejects(tracker.link('TASK-404', 'https://github.com/o/r/pull/10'), /has no card TASK-404/)
  })
})

/**
 * The routine, not the adapter: `tracker-sync` over the same kind of board, with
 * the real store behind it.
 *
 * The package suites test the two ends separately and meet at fakes, which leaves
 * one question neither can answer — do they fit? A pull that proposes a Work the
 * store refuses, a `work.review_requested` whose `pr` the board cannot render, a
 * card that moves to a column the profile spelled differently: all of those are
 * green in both suites and broken in a daemon. So this file runs the production
 * `sync` against the production adapter, reads the Work rows the store projected,
 * and reads the card back through the CLI.
 *
 * The forge is the only stand-in, and only for the PR's identity: the URL a card
 * is linked to is built from the `pr` the event names, so the event is given the
 * row a `PullRequests` port reported rather than a number typed here.
 */

const NOW = '2026-11-10T09:00:00.000Z' as Timestamp
const REPO = 'sandbox/tmux-fleet' as Repo
/** §10 pins a merge to forty hex characters, so a readable `sha-1` would be refused before it landed. */
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' as Sha
const ENGINEER = 'engineer-1' as PeerId

const fixedClock: Clock = { now: () => NOW, millis: () => Date.parse(NOW) }

/**
 * The columns this board has, written the way Backlog.md says to write them. It
 * refuses `config set statuses` ("edit the list in the project config file
 * directly"), which is why a test that needs a `Review` column edits the file the
 * CLI pointed at rather than inventing a status `task edit` would reject.
 */
const setStatuses = async (project: string, statuses: readonly string[]): Promise<void> => {
  const file = join(project, 'backlog', 'config.yml')
  const text = await readFile(file, 'utf8')
  const line = `statuses: [${statuses.map((status) => JSON.stringify(status)).join(', ')}]`
  assert.match(text, /^statuses:/m, 'the config the CLI wrote has no statuses line')
  await writeFile(file, text.replace(/^statuses:.*$/m, line), 'utf8')
}

describe('tracker-sync over a real board', { skip: installed ? false : 'backlog is not on PATH' }, () => {
  let project: string
  let storeHome: string
  let store: EventStore
  let deps: TrackerSyncDeps

  /** The heartbeat's context: no event, so the run is a pull. */
  const heartbeat = (): RoutineContext => ({
    routineId: 'tracker-sync',
    kind: 'tracker-sync',
    trigger: 'heartbeat',
    at: NOW,
    clock: fixedClock,
  })

  /** The sink's context: the committed event that woke the run, as the scheduler hands it over. */
  const woke = (event: FleetEvent): RoutineContext => ({
    routineId: 'tracker-sync',
    kind: 'tracker-sync',
    trigger: 'event',
    at: NOW,
    event,
    clock: fixedClock,
  })

  /** Append one event and read back the committed form, which is what a wake is given. */
  const appendOne = async (event: AppendEvent): Promise<FleetEvent> => {
    const [seq] = await store.append([event])
    assert.ok(seq !== undefined, 'the store refused the event')
    const [committed] = await store.read(seq, 1)
    assert.ok(committed !== undefined, `the store has no event at seq ${String(seq)}`)
    return committed
  }

  const eventsOf = async <T extends FleetEvent['type']>(type: T): Promise<readonly Extract<FleetEvent, { type: T }>[]> => {
    const all = await store.read(0, 10_000)
    return all.filter((event): event is Extract<FleetEvent, { type: T }> => event.type === type)
  }

  before(async () => {
    project = await mkdtemp(join(tmpdir(), 'fleet-backlog-sync-'))
    storeHome = await mkdtemp(join(tmpdir(), 'fleet-backlog-store-'))
    for (const args of [
      ['init', 'demo', '--agent-instructions', 'none', '--no-git'],
      ['task', 'create', 'First card', '-d', 'Lists should page.', '--plain'],
      ['task', 'create', 'Second card', '--plain'],
    ] as const) {
      const result = await execFileBacklog(args, { cwd: project })
      assert.equal(result.code, 0, `backlog ${args.join(' ')} exited ${String(result.code)}: ${result.stderr}`)
    }
    await setStatuses(project, ['To Do', 'In Progress', 'In Review', 'Done'])

    store = await openSqliteStore({
      path: join(storeHome, 'store.sqlite'),
      clock: fixedClock,
      // A hand-written log is meant to be complete: an event that names a row the
      // log never opened is this test's bug, not something to record quietly.
      strictProjection: true,
    })

    deps = {
      read: store.reader(),
      tracker: createBacklogTracker({
        path: project,
        // The profile the runbook shows: three columns, and nothing else.
        statuses: { in_progress: 'In Progress', in_review: 'In Review', merged: 'Done' },
      }),
      store,
      system: 'backlog',
      query: 'To Do,In Progress',
      role: 'engineer',
    }
  })

  after(async () => {
    await store.close()
    await rm(project, { recursive: true, force: true })
    await rm(storeHome, { recursive: true, force: true })
  })

  it('a heartbeat proposes one Work per card, carrying the ticket the brief is built from', async () => {
    await sync(deps, heartbeat())

    const proposed = await eventsOf('work.proposed')
    assert.deepEqual(
      proposed.map((event) => event.data.external?.key),
      ['TASK-1', 'TASK-2'],
    )

    const [first] = proposed
    assert.ok(first !== undefined)
    assert.equal(first.data.title, 'First card')
    // The body and the link are the brief: the card's own words, and somewhere a
    // peer can open them. Both come from the card, not from the list row.
    assert.equal(first.data.body, 'Lists should page.')
    assert.equal(first.data.external?.system, 'backlog')
    assert.match(first.data.external?.url ?? '', /^backlog\/tasks\/task-1 - .*\.md$/)
    assert.equal(first.data.role, 'engineer')

    // Reading the board is not moving it: the cards are where the humans left them.
    assert.equal((await readCard(project, 'TASK-1')).status, 'To Do')
    assert.equal((await readCard(project, 'TASK-2')).status, 'To Do')
  })

  it('a second heartbeat proposes nothing: dedupe is by (system, key) against the log', async () => {
    await sync(deps, heartbeat())

    assert.equal((await eventsOf('work.proposed')).length, 2, 'a card already taken on was proposed again')
    // And the run still says what it did, so "nothing new" is not "nothing happened".
    const synced = await eventsOf('tracker.synced')
    assert.deepEqual(
      synced.map((event) => ({ pulled: event.data.pulled, proposed: event.data.proposed })),
      [
        { pulled: 2, proposed: 2 },
        { pulled: 2, proposed: 0 },
      ],
    )
  })

  it('walking the Work to merged moves the card In Progress → In Review → Done, and links the PR once', async () => {
    const [first] = (await eventsOf('work.proposed')).filter((event) => event.data.external?.key === 'TASK-1')
    assert.ok(first !== undefined, 'TASK-1 was never proposed')
    const workId = first.data.workId

    await sync(
      deps,
      woke(
        await appendOne({
          ts: NOW,
          type: 'work.started',
          subject: workId,
          actor: `peer:${ENGINEER}`,
          data: { workId, peerId: ENGINEER },
        }),
      ),
    )
    assert.equal((await readCard(project, 'TASK-1')).status, 'In Progress')
    // The other card is not this Work's business, and one event moves exactly one card.
    assert.equal((await readCard(project, 'TASK-2')).status, 'To Do')

    const forge = createFakeForge()
    const pr = forge.open({ repo: REPO, number: 7, workId })
    const reviewed = await appendOne({
      ts: NOW,
      type: 'work.review_requested',
      subject: workId,
      actor: `peer:${ENGINEER}`,
      data: { workId, peerId: ENGINEER, pr: { repo: pr.repo, number: pr.number } },
    })
    await sync(deps, woke(reviewed))

    const card = await readCard(project, 'TASK-1')
    assert.equal(card.status, 'In Review')
    const url = `https://github.com/${String(REPO)}/pull/7`
    const notes = String(card.implementationNotes ?? '')
    assert.equal(notes.split(url).length - 1, 1, `the PR was written ${String(notes.split(url).length - 1)} times`)

    // The same wake twice — a re-run, a resumed session — must not gather a second line.
    await sync(deps, woke(reviewed))
    assert.equal(String((await readCard(project, 'TASK-1')).implementationNotes ?? '').split(url).length - 1, 1)

    await sync(
      deps,
      woke(
        await appendOne({
          ts: NOW,
          type: 'work.merged',
          subject: workId,
          actor: 'scheduler',
          data: { workId, pr: { repo: pr.repo, number: pr.number }, headSha: HEAD_SHA },
        }),
      ),
    )
    assert.equal((await readCard(project, 'TASK-1')).status, 'Done')

    // Three runs moved a card, three said they moved a card; only the review asked for a link.
    const synced = await eventsOf('tracker.synced')
    assert.deepEqual(
      synced.slice(2).map((event) => ({ transitioned: event.data.transitioned, linked: event.data.linked, failed: event.data.failed })),
      [
        { transitioned: 1, linked: 0, failed: 0 },
        { transitioned: 1, linked: 1, failed: 0 },
        { transitioned: 1, linked: 1, failed: 0 },
        { transitioned: 1, linked: 0, failed: 0 },
      ],
    )
  })
})
