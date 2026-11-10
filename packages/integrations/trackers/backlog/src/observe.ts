/**
 * What `backlog task --json` prints, and what the contract's shapes call it
 * (architecture §3). The CLI is an external program with its own schema
 * versioning, so every field is read defensively: a row that is not an object,
 * or an id that is missing, is an `external_failed` rather than a Work proposed
 * with `undefined` for a title.
 *
 * Backlog.md is a directory of markdown files, so it has no browse URL. What it
 * has is each card's path, which is exactly the thing a human opens — so that is
 * the `url` unless the profile gives a `urlBase` to hang it off (a repo's blob
 * URL, typically).
 */

import { fleetError } from '@fleet/foundation-core'
import type { ExternalItem } from '@fleet/foundation-contracts'

/** The `system` every item from this adapter carries; it is also the profile's `system: backlog`. */
export const BACKLOG_SYSTEM = 'backlog'

export interface ObserveOptions {
  /** A prefix the card's path is joined to. Without it, `url` is the path as the CLI reports it. */
  readonly urlBase?: string
  /** The clock, for items whose CLI row carries no mtime. */
  readonly now: () => string
}

const asObject = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fleetError('external_failed', `backlog ${what} printed something that is not an object`, { details: { what } })
  }
  return value as Record<string, unknown>
}

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** `schemaVersion` is the CLI's promise about the shape; a version this build does not know is refused. */
const VERSION = 1

const checked = (raw: unknown, what: string): Record<string, unknown> => {
  const object = asObject(raw, what)
  if (object['schemaVersion'] !== VERSION) {
    throw fleetError('external_failed', `backlog ${what} printed schemaVersion ${String(object['schemaVersion'])}, not ${String(VERSION)}`, {
      details: { what, schemaVersion: object['schemaVersion'] },
    })
  }
  return object
}

/**
 * A card's path, as a URL. Relative path segments are encoded one at a time so a
 * card named `task-1 - First task.md` opens instead of arriving half-escaped.
 */
export const urlOfPath = (path: string | undefined, urlBase: string | undefined): string | undefined => {
  if (path === undefined) return undefined
  if (urlBase === undefined) return path
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${urlBase.replace(/\/+$/, '')}/${encoded}`
}

/** One row of `backlog task list --json`. The list carries no description: `get` is what reads the body. */
export const itemFromRow = (raw: unknown, options: ObserveOptions): ExternalItem => {
  // A list row and a view's `task` have the same fields — `taskFromView` hands
  // the inner object here — so `pull` and `get` map through one function.
  const task = asObject(raw, 'task')
  const key = stringOrUndefined(task['id'])
  const title = stringOrUndefined(task['title'])
  const status = stringOrUndefined(task['status'])
  if (key === undefined || title === undefined || status === undefined) {
    throw fleetError('external_failed', 'backlog task printed a row without an id, a title or a status', {
      details: { hasKey: key !== undefined, hasTitle: title !== undefined, hasStatus: status !== undefined },
    })
  }
  const updatedAt = stringOrUndefined(task['updatedAt'])
  const url = urlOfPath(stringOrUndefined(task['path']), options.urlBase)
  const body = stringOrUndefined(task['description'])
  return {
    system: BACKLOG_SYSTEM,
    key,
    title,
    ...(body === undefined ? {} : { body }),
    status,
    ...(url === undefined ? {} : { url }),
    // A card that has never been edited carries `updatedAt: null`. The read still
    // happened, so it is stamped with the moment it did rather than left blank.
    updatedAt: updatedAt ?? options.now(),
  }
}

/** `backlog task list --json` → its rows. An empty board is an empty list, not an error. */
export const rowsFromList = (raw: unknown): readonly unknown[] => {
  const object = checked(raw, 'task list')
  const tasks = object['tasks']
  if (!Array.isArray(tasks)) {
    throw fleetError('external_failed', 'backlog task list printed no `tasks` array')
  }
  return tasks
}

/** `backlog task view <id> --json` → the card, or `undefined` when the view names no task. */
export const taskFromView = (raw: unknown): Record<string, unknown> | undefined => {
  const object = checked(raw, 'task view')
  const task = object['task']
  return typeof task === 'object' && task !== null && !Array.isArray(task)
    ? (task as Record<string, unknown>)
    : undefined
}

/** The implementation notes a `link` checks before appending, so the same PR URL is recorded once. */
export const notesFrom = (task: Record<string, unknown>): string => {
  const notes = task['implementationNotes']
  return typeof notes === 'string' ? notes : ''
}

/**
 * Whether the notes already carry `note`, as whole lines. A substring match
 * called `pull/1` recorded when `pull/12` was, and a short note recorded when a
 * longer one began the same way, so a PR or a note was silently never written
 * (TASK-30). `\n` bounds both ends so a multi-line note matches as a block.
 */
export const hasNote = (notes: string, note: string): boolean =>
  `\n${notes.replaceAll('\r\n', '\n')}\n`.includes(`\n${note}\n`)

/** The card's PR link, as this adapter writes it into the notes. */
export const linkNote = (prUrl: string): string => `PR: ${prUrl}`

/** `backlog`'s way of saying the card is not in this working copy. */
export const isMissing = (stderr: string): boolean => /not found/i.test(stderr)
