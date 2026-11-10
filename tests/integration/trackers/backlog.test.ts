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
 * Skipped when `backlog` is not on `PATH` — CI has no binary. The project lives
 * outside the repo and is removed on teardown, so `git status` stays clean.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { Tracker } from '../../../packages/foundation/contracts/src/index.ts'
import { createBacklogTracker, execFileBacklog } from '../../../packages/integrations/trackers/backlog/src/index.ts'

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
    // A list row carries no `path`, so `pull` has no URL to give — the adapter maps one when the CLI
    // prints it, and `get` (a `task view`) is where it does. Pinned because it is invisible in the
    // package suite, whose fixtures give list rows a path the real CLI does not.
    assert.equal(first?.url, undefined)

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
