/**
 * The `backlog` adapter over the `Tracker` port (§3). Every case runs an injected
 * runner: no `backlog` binary, no project on disk, no process. What is asserted
 * is the argv the CLI would have received and the `ExternalItem` that comes
 * back, because those two are the whole adapter — the sequence `tracker-sync`
 * relies on, and the shape the contract names.
 *
 * The CLI's own JSON is copied from `backlog` 1.55.3, including the parts this
 * adapter ignores, so a field the CLI renames fails here rather than in a daemon.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FleetError } from '@fleet/foundation-core'
import type { WorkState } from '@fleet/foundation-contracts'
import { createBacklogCli, type BacklogResult, type BacklogRunner } from '../src/cli.ts'
import { urlOfPath } from '../src/observe.ts'
import { createBacklogTracker } from '../src/tracker.ts'

const PROJECT = '/tmp/some-project'

/** One recorded call: the argv, and the directory the CLI was told to run in. */
interface Call {
  readonly args: readonly string[]
  readonly cwd: string
}

/**
 * A runner that answers from a queue and records every call. Exhausting the
 * queue is an assertion failure, not an empty answer: a test that calls the CLI
 * one time more than it means to should say so.
 */
const runnerOf = (...answers: readonly BacklogResult[]): { run: BacklogRunner; calls: Call[] } => {
  const calls: Call[] = []
  let next = 0
  return {
    calls,
    run: async (args, options) => {
      calls.push({ args, cwd: options.cwd })
      const answer = answers[next]
      next += 1
      assert.ok(answer !== undefined, `unexpected backlog call: ${args.join(' ')}`)
      return answer
    },
  }
}

const ok = (stdout: unknown): BacklogResult => ({
  code: 0,
  stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  stderr: '',
})

const failed = (code: number, stderr: string): BacklogResult => ({ code, stdout: '', stderr })

/** A card as `backlog task view --json` prints it (1.55.3). */
const card = (fields: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  kind: 'task-view',
  task: {
    id: 'TASK-1',
    title: 'Add pagination',
    status: 'To Do',
    updatedAt: '2026-11-01T10:00:00.000Z',
    path: 'backlog/tasks/task-1 - Add pagination.md',
    description: 'Lists should page.',
    implementationNotes: '',
    ...fields,
  },
})

const list = (tasks: readonly unknown[]): Record<string, unknown> => ({ schemaVersion: 1, kind: 'task-list', tasks })

const NOW = '2026-11-10T09:00:00.000Z'
const clock = { now: () => NOW, millis: () => Date.parse(NOW) }

const trackerOf = (run: BacklogRunner, options: { statuses?: Partial<Record<WorkState, string>>; urlBase?: string } = {}) =>
  createBacklogTracker({
    path: PROJECT,
    run,
    clock,
    ...(options.statuses === undefined ? {} : { statuses: options.statuses }),
    ...(options.urlBase === undefined ? {} : { urlBase: options.urlBase }),
  })

describe('pull: the profile query is the board status filter', () => {
  it('asks for the named columns and maps each row', async () => {
    const { run, calls } = runnerOf(
      ok(list([{ id: 'TASK-1', title: 'Add pagination', status: 'To Do', updatedAt: '2026-11-01T10:00:00.000Z' }])),
    )

    const items = await trackerOf(run).pull('To Do,In Progress')

    assert.deepEqual(calls, [{ args: ['task', 'list', '--json', '-s', 'To Do,In Progress'], cwd: PROJECT }])
    assert.deepEqual(items, [
      {
        system: 'backlog',
        key: 'TASK-1',
        title: 'Add pagination',
        status: 'To Do',
        updatedAt: '2026-11-01T10:00:00.000Z',
      },
    ])
  })

  it('a row carries no body: the list is a summary, and get is what reads the card', async () => {
    const { run } = runnerOf(ok(list([{ id: 'TASK-1', title: 'Add pagination', status: 'To Do' }])))

    const [first] = await trackerOf(run).pull('To Do')

    assert.equal(first?.body, undefined)
  })

  it('an empty query asks for the whole board rather than a column named ""', async () => {
    const { run, calls } = runnerOf(ok(list([])))

    assert.deepEqual(await trackerOf(run).pull('   '), [])
    assert.deepEqual(calls[0]?.args, ['task', 'list', '--json'])
  })

  it('stamps a row with no mtime, rather than leaving the read undated', async () => {
    const { run } = runnerOf(ok(list([{ id: 'TASK-1', title: 't', status: 'To Do', updatedAt: null }])))

    const [first] = await trackerOf(run).pull('To Do')

    assert.equal(first?.updatedAt, NOW)
  })

  it('a schemaVersion this build does not know is refused, not guessed at', async () => {
    const { run } = runnerOf(ok({ schemaVersion: 2, kind: 'task-list', tasks: [] }))

    await assert.rejects(() => trackerOf(run).pull('To Do'), (thrown: unknown) => {
      assert.ok(thrown instanceof FleetError)
      assert.equal(thrown.code, 'external_failed')
      assert.match(thrown.message, /schemaVersion 2/)
      return true
    })
  })

  it('a failed list is an external failure, not an empty board', async () => {
    const { run } = runnerOf(failed(1, 'Cannot read project'))

    await assert.rejects(() => trackerOf(run).pull('To Do'), (thrown: unknown) => {
      assert.ok(thrown instanceof FleetError)
      assert.equal(thrown.code, 'external_failed')
      return true
    })
  })
})

describe('get: one card, and the difference between "gone" and "broken"', () => {
  it('reads the card with a view and maps its body and path', async () => {
    const { run, calls } = runnerOf(ok(card()))

    const item = await trackerOf(run).get('TASK-1')

    assert.deepEqual(calls[0]?.args, ['task', 'view', 'TASK-1', '--json'])
    assert.deepEqual(item, {
      system: 'backlog',
      key: 'TASK-1',
      title: 'Add pagination',
      body: 'Lists should page.',
      status: 'To Do',
      url: 'backlog/tasks/task-1 - Add pagination.md',
      updatedAt: '2026-11-01T10:00:00.000Z',
    })
  })

  it('is undefined for a card the working copy does not have', async () => {
    const { run } = runnerOf(failed(1, 'Task TASK-99 not found.'))

    assert.equal(await trackerOf(run).get('TASK-99'), undefined)
  })

  it('throws for any other failure, so a broken project never reads as a deleted card', async () => {
    const { run } = runnerOf(failed(2, 'Error: project config is corrupt'))

    await assert.rejects(() => trackerOf(run).get('TASK-1'), (thrown: unknown) => {
      assert.ok(thrown instanceof FleetError)
      assert.equal(thrown.code, 'external_failed')
      assert.deepEqual(thrown.details, { key: 'TASK-1', exitCode: 2 })
      return true
    })
  })

  it('throws when the CLI exits 0 without JSON', async () => {
    const { run } = runnerOf(ok('not json at all'))

    await assert.rejects(() => trackerOf(run).get('TASK-1'), /printed no JSON/)
  })
})

describe("transition: the profile maps a WorkState onto the board's own column", () => {
  it('edits the card to the mapped status', async () => {
    const { run, calls } = runnerOf(ok(''))

    await trackerOf(run, { statuses: { in_progress: 'In Progress' } }).transition('TASK-1', 'in_progress')

    assert.deepEqual(calls[0]?.args, ['task', 'edit', 'TASK-1', '-s', 'In Progress', '--plain'])
  })

  it('does nothing for a state the profile does not map', async () => {
    const { run, calls } = runnerOf()

    await trackerOf(run, { statuses: { in_progress: 'In Progress' } }).transition('TASK-1', 'in_review')

    assert.deepEqual(calls, [], 'a state the profile is silent about must not invent a column')
  })

  it('throws when the edit is refused, so the sync can count it', async () => {
    const { run } = runnerOf(failed(1, 'Status "Nope" is not valid'))

    await assert.rejects(
      () => trackerOf(run, { statuses: { merged: 'Nope' } }).transition('TASK-1', 'merged'),
      (thrown: unknown) => {
        assert.ok(thrown instanceof FleetError)
        assert.equal(thrown.code, 'external_failed')
        // The argv is narrowed to its first words: a note or a body is not an error line.
        assert.deepEqual(thrown.details, { argv: ['task', 'edit', 'TASK-1'], exitCode: 1 })
        return true
      },
    )
  })
})

describe('link: the PR URL is appended to the notes, once', () => {
  it('appends a note when the card has none', async () => {
    const { run, calls } = runnerOf(ok(card()), ok(''))

    await trackerOf(run).link('TASK-1', 'https://github.com/acme/widgets/pull/7')

    assert.deepEqual(calls.map((call) => call.args), [
      ['task', 'view', 'TASK-1', '--json'],
      ['task', 'edit', 'TASK-1', '--append-notes', 'PR: https://github.com/acme/widgets/pull/7', '--plain'],
    ])
  })

  it('is idempotent: a card that already names the PR is not edited again', async () => {
    const { run, calls } = runnerOf(ok(card({ implementationNotes: 'Notes a human wrote.\nPR: https://github.com/acme/widgets/pull/7' })))

    await trackerOf(run).link('TASK-1', 'https://github.com/acme/widgets/pull/7')

    assert.deepEqual(calls.map((call) => call.args), [['task', 'view', 'TASK-1', '--json']])
  })

  it('a note appended for a different PR is appended, not treated as this one', async () => {
    const { run, calls } = runnerOf(ok(card({ implementationNotes: 'PR: https://github.com/acme/widgets/pull/6' })), ok(''))

    await trackerOf(run).link('TASK-1', 'https://github.com/acme/widgets/pull/7')

    assert.equal(calls.length, 2)
  })

  it('throws rather than inventing a card when the ticket is gone', async () => {
    const { run, calls } = runnerOf(failed(1, 'Task TASK-99 not found.'))

    await assert.rejects(() => trackerOf(run).link('TASK-99', 'https://github.com/acme/widgets/pull/7'), /has no card TASK-99/)
    assert.equal(calls.length, 1, 'a missing card is not a reason to create one')
  })
})

describe('urlOfPath: a card path becomes something a human can open', () => {
  it('is the path as the CLI reports it when the profile gives no base', () => {
    assert.equal(urlOfPath('backlog/tasks/task-1 - Add pagination.md', undefined), 'backlog/tasks/task-1 - Add pagination.md')
  })

  it('encodes each segment against a base, so a spaced filename opens', () => {
    assert.equal(
      urlOfPath('backlog/tasks/task-1 - Add pagination.md', 'https://github.com/acme/widgets/blob/main'),
      'https://github.com/acme/widgets/blob/main/backlog/tasks/task-1%20-%20Add%20pagination.md',
    )
  })

  it('is undefined when the CLI named no path', () => {
    assert.equal(urlOfPath(undefined, 'https://github.com/x/y'), undefined)
  })
})

describe('the CLI seam', () => {
  it('runs every call in the profile project directory, never the process directory', async () => {
    const { run, calls } = runnerOf(ok(list([])), ok(list([])))

    await createBacklogCli('/one', run).json(['task', 'list', '--json'])
    await createBacklogCli('/two', run).json(['task', 'list', '--json'])

    assert.deepEqual(calls.map((call) => call.cwd), ['/one', '/two'])
  })
})
