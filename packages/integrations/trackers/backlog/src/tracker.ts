/**
 * The `Tracker` port over the `backlog` CLI (architecture §3). Every call is one
 * argv, and the mapping lives in `observe.ts`, so this file is only the
 * sequence: which arguments, in which order, and what a non-zero exit means.
 *
 * Two behaviours the sync depends on and would be wrong without:
 *
 * - **`get` distinguishes "no such card" from "the call failed".** A missing card
 *   is `undefined`; a CLI that fails for any other reason throws, so a broken
 *   checkout never reads as "the card was deleted".
 * - **`transition` speaks `WorkState`.** The tracker's own vocabulary arrives as
 *   the profile's `statuses` map, so this is the one place the two meet: a state
 *   the profile does not map is *not* sent anywhere, because inventing a column
 *   would rewrite a board the fleet was never told about.
 *
 * `link` is idempotent on purpose: `tracker-sync` may see the same
 * `work.review_requested` twice (a re-run, a resumed session), and a card that
 * gathered one `PR:` line per wake would be unreadable.
 */

import { fleetError, systemClock, type Clock } from '@fleet/foundation-core'
import type { ExternalItem, Tracker, WorkState } from '@fleet/foundation-contracts'
import { createBacklogCli, execFileBacklog, type BacklogCli, type BacklogRunner } from './cli.ts'
import {
  BACKLOG_SYSTEM,
  isMissing,
  itemFromRow,
  linkNote,
  notesFrom,
  rowsFromList,
  taskFromView,
  type ObserveOptions,
} from './observe.ts'

export interface BacklogTrackerOptions {
  /** The Backlog.md project directory. Every call runs here; the CLI is per-directory. */
  readonly path: string
  /** `WorkState` → the board's own status. A state the profile omits is left alone. */
  readonly statuses?: Partial<Record<WorkState, string>>
  /** A prefix a card's path becomes a URL under; a repo's blob URL, typically. */
  readonly urlBase?: string
  /** Defaults to `backlog` on `PATH`. A test supplies a fake and reads the argv. */
  readonly run?: BacklogRunner
  /** Defaults to a CLI over `run` and `path`; a test may inject one outright. */
  readonly cli?: BacklogCli
  readonly clock?: Clock
}

/** `backlog task list` takes its statuses as one comma-separated `--status`, or none for the whole board. */
const queryArgs = (query: string): readonly string[] => {
  const statuses = query.trim().replace(/\s*,\s*/g, ',')
  return statuses === '' ? [] : ['-s', statuses]
}

/**
 * The port over the CLI. `options.path` is the project; everything else is the
 * profile's opinion of the board.
 */
export const createBacklogTracker = (options: BacklogTrackerOptions): Tracker => {
  const cli = options.cli ?? createBacklogCli(options.path, options.run ?? execFileBacklog)
  const clock = options.clock ?? systemClock
  const statuses = options.statuses ?? {}
  const observe: ObserveOptions = {
    ...(options.urlBase === undefined ? {} : { urlBase: options.urlBase }),
    now: () => clock.now(),
  }

  /** One `task view`, with "not found" as `undefined` and any other failure thrown. */
  const view = async (key: string): Promise<Record<string, unknown> | undefined> => {
    const result = await cli.run(['task', 'view', key, '--json'])
    if (result.code !== 0) {
      // A card that is not in this working copy is an answer; anything else is a failed read.
      if (isMissing(result.stderr)) return undefined
      throw fleetError('external_failed', `backlog task view ${key} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
        details: { key, exitCode: result.code },
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout) as unknown
    } catch (thrown) {
      throw fleetError('external_failed', `backlog task view ${key} printed no JSON`, { cause: thrown })
    }
    return taskFromView(parsed)
  }

  const edit = async (args: readonly string[], what: string): Promise<void> => {
    const result = await cli.run(args)
    if (result.code !== 0) {
      throw fleetError('external_failed', `backlog ${what} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
        details: { argv: args.slice(0, 3), exitCode: result.code },
      })
    }
  }

  return {
    /** The profile's query is Backlog.md's status filter: `"To Do,In Progress"` means those two columns. */
    async pull(query) {
      const raw = await cli.json(['task', 'list', '--json', ...queryArgs(query)])
      return rowsFromList(raw).map((row) => itemFromRow(row, observe))
    },

    async get(key) {
      const task = await view(key)
      return task === undefined ? undefined : itemFromRow(task, observe)
    },

    async transition(key, to) {
      const status = statuses[to]
      // Not mapped: the profile has no opinion, and a board that was never told
      // how this fleet's states line up must not be edited anyway.
      if (status === undefined) return
      await edit(['task', 'edit', key, '-s', status, '--plain'], `task edit ${key} -s ${status}`)
    },

    async link(key, prUrl) {
      const task = await view(key)
      if (task === undefined) {
        throw fleetError('external_failed', `cannot link ${prUrl}: ${BACKLOG_SYSTEM} has no card ${key}`, { details: { key } })
      }
      const note = linkNote(prUrl)
      if (notesFrom(task).includes(note)) return
      // Appended, never set: the notes are the humans' too (§3 keeps the board a peer, not a mirror).
      await edit(['task', 'edit', key, '--append-notes', note, '--plain'], `task edit ${key} --append-notes`)
    },
  }
}
