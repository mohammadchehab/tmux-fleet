/**
 * The store interface (architecture §3, §5.4, §15). One append-only SQLite
 * database per profile; everything the code reads is a projection of it, so a
 * rebuild is always possible and a replay reproduces every decision.
 *
 * This is the contract every caller is written against (`EventSink` for the
 * writes, `ReadModel` for the reads); `sqlite-store.ts` is its implementation.
 */

import { fleetError, type Clock, type Seq } from '@fleet/foundation-core'
import { appendIssues, type AppendEvent, type FleetEvent, type ReadModel } from '@fleet/foundation-contracts'

export type { AppendEvent }

/**
 * The write boundary (§3, §5.4). `append` is the only way into the store, so it
 * is the one place that must not be forgiving: an event is decoded strictly and
 * an unknown key is refused. A reader tolerates unknown keys so a newer writer
 * does not break it; a writer that misspells `judgeModel` must be told, because
 * the key would otherwise be dropped and lost silently.
 *
 * Throws `FleetError('invalid_input')` listing every issue in the batch.
 */
export const assertAppendable = (batch: readonly AppendEvent[]): void => {
  const issues = batch.flatMap((event, index) =>
    appendIssues(event).map((issue) => `[${index}] ${String(event.type)} ${issue.path}: ${issue.message}`),
  )
  if (issues.length === 0) return
  throw fleetError(
    'invalid_input',
    `append is strict and refused ${issues.length} issue(s): ${issues.join('; ')}`,
    { details: { issues } },
  )
}

/** How a store is opened. `path` is `~/.fleet/<profile>/store/store.sqlite` (§1.1). */
export interface StoreOptions {
  readonly path: string
  /** Injected so `append` stamps `ts` deterministically in a replay test (§5.4). */
  readonly clock?: Clock
  /** A read-only handle for `fleet replay` and `fleet ls` against a live daemon. */
  readonly readOnly?: boolean
}

/**
 * Appending is the only write. A batch is validated strictly first
 * (`assertAppendable`), then atomic and ordered: either the whole batch gets
 * consecutive seqs or none of it does, and projections are updated in the same
 * transaction.
 */
export interface EventStore {
  /** Apply any migrations the database has not seen; idempotent. */
  migrate(): Promise<void>

  /** Append a batch atomically. Returns the seqs, in the order given. */
  append(batch: readonly AppendEvent[]): Promise<readonly Seq[]>

  /** Read a window, oldest first. `from` is inclusive. */
  read(from: Seq, limit?: number): Promise<readonly FleetEvent[]>

  /** Stream a window; `to` is inclusive, and absent means "to the head". */
  iterate(from: Seq, to?: Seq): AsyncIterable<FleetEvent>

  /** The newest seq, or 0 when the store is empty. */
  latestSeq(): Promise<Seq>

  /** The projections, read-only: what the PM, the board and the CLI read (§3). */
  reader(): ReadModel

  /** Drop and rebuild every projection by replaying `events` (§5.4). */
  rebuild(): Promise<void>

  /** The nightly copy under `store/backup/` (§1.1). */
  backup(targetPath: string): Promise<void>

  close(): Promise<void>
}

/** What `apps/daemon` injects: a way to open the store it owns (§2). */
export interface StoreFactory {
  open(options: StoreOptions): Promise<EventStore>
}
