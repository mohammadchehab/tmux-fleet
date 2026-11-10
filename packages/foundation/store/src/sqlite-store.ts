/**
 * The `node:sqlite` event store (architecture §3, §5.4, §15 phase 1). One file
 * per profile; `events` is the source of truth and is append-only, and every
 * other table is a projection this store keeps current on the write path and can
 * rebuild from the log at any time.
 *
 * The write path is deliberately narrow: `assertAppendable` refuses a bad batch
 * before a single row is written, then one transaction inserts the events and
 * runs the projections runner, so a partially applied batch is impossible.
 */

import { existsSync } from 'node:fs'
import {
  fleetError,
  parse,
  systemClock,
  toFleetError,
  type Clock,
  type Seq,
  type Timestamp,
} from '@fleet/foundation-core'
import {
  fleetEvent,
  type AppendEvent,
  type FleetEvent,
  type ReadModel,
} from '@fleet/foundation-contracts'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './ddl.ts'
import { applyEvent, clearProjections, readers } from './projections.ts'
import { Sqlite } from './sql.ts'
import {
  assertAppendable,
  type EventStore,
  type StoreFactory,
  type StoreHealth,
  type StoreOptions,
} from './store.ts'

/** A row of `events` as SQLite hands it back. `data` is the JSON of the event's payload. */
interface EventRow {
  readonly seq: number
  readonly ts: string
  readonly type: string
  readonly subject: string
  readonly actor: string
  readonly caused_by: string | null
  readonly data: string
}

const toEvent = (row: EventRow): FleetEvent =>
  parse(fleetEvent(), {
    seq: Number(row.seq),
    ts: row.ts,
    type: row.type,
    subject: row.subject,
    actor: row.actor,
    causedBy: row.caused_by === null ? undefined : (JSON.parse(row.caused_by) as unknown),
    data: JSON.parse(row.data) as unknown,
  })

const SELECT_EVENTS = 'SELECT seq, ts, type, subject, actor, caused_by, data FROM events'

class SqliteEventStore implements EventStore {
  readonly #db: Sqlite
  readonly #clock: Clock
  readonly #readOnly: boolean
  readonly #strictProjection: boolean

  constructor(db: Sqlite, clock: Clock, readOnly: boolean, strictProjection: boolean) {
    this.#db = db
    this.#clock = clock
    this.#readOnly = readOnly
    this.#strictProjection = strictProjection
  }

  /**
   * `strictProjection` (§3): a miss the projections just recorded is a bug in the log
   * being applied, not a fact about it. Thrown from inside the transaction, so a strict
   * store rolls back the event that caused the miss along with everything after it —
   * a test that named an entity it never opened gets no half-applied log to read.
   */
  #assertProjectionsClean(fromSeq: number): void {
    if (!this.#strictProjection) return
    const misses = this.#db.all<{ event_seq: number; projection: string; detail: string }>(
      'SELECT event_seq, projection, detail FROM projection_anomalies WHERE event_seq >= ? ORDER BY event_seq, projection',
      fromSeq,
    )
    if (misses.length === 0) return
    throw fleetError(
      'store_failed',
      `strictProjection: ${misses.length} projection miss(es): ${misses
        .map((miss) => `#${miss.event_seq} ${miss.projection}: ${miss.detail}`)
        .join('; ')}`,
      { details: { misses } },
    )
  }

  #assertWritable(operation: string): void {
    if (this.#readOnly) {
      throw fleetError('invalid_input', `the store was opened read-only and cannot ${operation}`)
    }
  }

  /** The schema version the database has applied; `0` before the first migration. */
  #schemaVersion(): number {
    const table = this.#db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'store_meta'",
    )
    if (table === undefined) return 0
    const row = this.#db.get<{ value: string }>('SELECT value FROM store_meta WHERE key = ?', 'schema_version')
    return row === undefined ? 0 : Number(row.value)
  }

  async migrate(): Promise<void> {
    this.#assertWritable('migrate')
    const current = this.#schemaVersion()
    if (current > LATEST_SCHEMA_VERSION) {
      throw fleetError(
        'store_failed',
        `the store is at schema ${current}, newer than this build's ${LATEST_SCHEMA_VERSION}; upgrade the daemon`,
      )
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue
      this.#db.transaction(() => {
        for (const statement of migration.statements) this.#db.exec(statement)
        for (const [key, value] of [
          ['schema_version', String(migration.version)],
          [`migration:${String(migration.version)}`, migration.name],
        ] as const) {
          this.#db.run(
            'INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            key,
            value,
          )
        }
      })
    }
  }

  async append(batch: readonly AppendEvent[]): Promise<readonly Seq[]> {
    this.#assertWritable('append')
    // Strict, and before anything is written: a misspelt key must be reported,
    // not silently stored in a shape no reader will ever see (§3, §5.4).
    assertAppendable(batch)
    if (batch.length === 0) return []
    try {
      return this.#db.transaction(() => {
        const seqs = batch.map((event) => {
          // The producer stamps `ts`; the injected clock is the fallback, which is
          // what makes a replay test deterministic (§5.4).
          const ts: Timestamp = typeof event.ts === 'string' && event.ts.length > 0 ? event.ts : this.#clock.now()
          const { lastInsertRowid } = this.#db.run(
            'INSERT INTO events (ts, type, subject, actor, caused_by, data) VALUES (?, ?, ?, ?, ?, ?)',
            ts,
            event.type,
            event.subject,
            event.actor,
            event.causedBy === undefined ? null : JSON.stringify(event.causedBy),
            JSON.stringify(event.data),
          )
          // The seq is the store's, so the projection sees the envelope it will
          // see again on replay — exactly the same shape, from the same reducer.
          applyEvent(this.#db, parse(fleetEvent(), { ...event, seq: lastInsertRowid, ts }))
          return lastInsertRowid
        })
        // The batch is non-empty here, so there is a first seq: the strict check runs from the batch's own start.
        const first = seqs[0]
        if (first !== undefined) this.#assertProjectionsClean(first)
        return seqs
      })
    } catch (thrown) {
      throw toFleetError(thrown, 'store_failed')
    }
  }

  async read(from: Seq, limit = 1000): Promise<readonly FleetEvent[]> {
    return this.#db
      .all<EventRow>(`${SELECT_EVENTS} WHERE seq >= ? ORDER BY seq LIMIT ?`, from, limit)
      .map((row) => toEvent(row))
  }

  async *iterate(from: Seq, to?: Seq): AsyncIterable<FleetEvent> {
    const sql = to === undefined ? `${SELECT_EVENTS} WHERE seq >= ? ORDER BY seq` : `${SELECT_EVENTS} WHERE seq >= ? AND seq <= ? ORDER BY seq`
    for (const row of this.#db.iterate<EventRow>(sql, ...(to === undefined ? [from] : [from, to]))) {
      yield toEvent(row)
    }
  }

  async latestSeq(): Promise<Seq> {
    const row = this.#db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events')
    return row?.seq === null || row?.seq === undefined ? 0 : Number(row.seq)
  }

  /**
   * The log and its misses, as two counts. A report, not a transaction: an append
   * landing between them shows up in the next call rather than as a wrong answer.
   */
  async health(): Promise<StoreHealth> {
    const log = this.#db.get<{ events: number; seq: number | null }>(
      'SELECT COUNT(*) AS events, MAX(seq) AS seq FROM events',
    )
    const anomalies = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM projection_anomalies')
    const compactions = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_compactions')
    return {
      latestSeq: Number(log?.seq ?? 0),
      events: Number(log?.events ?? 0),
      anomalies: Number(anomalies?.n ?? 0),
      compactions: Number(compactions?.n ?? 0),
    }
  }

  reader(): ReadModel {
    return readers(this.#db)
  }

  /**
   * Drop every projection and replay the log from seq 1 (§5.4). One transaction,
   * so a reader never sees a half-built read model.
   */
  async rebuild(): Promise<void> {
    this.#assertWritable('rebuild')
    try {
      this.#db.transaction(() => {
        clearProjections(this.#db)
        for (const row of this.#db.iterate<EventRow>(`${SELECT_EVENTS} ORDER BY seq`)) {
          applyEvent(this.#db, toEvent(row))
        }
        // A replay has to agree with the append that wrote the log, so the same mode applies.
        this.#assertProjectionsClean(1)
      })
    } catch (thrown) {
      throw toFleetError(thrown, 'store_failed')
    }
  }

  async backup(targetPath: string): Promise<void> {
    if (existsSync(targetPath)) {
      throw fleetError('invalid_input', `backup target ${targetPath} already exists; a backup never overwrites`)
    }
    try {
      this.#db.backup(targetPath)
    } catch (thrown) {
      throw toFleetError(thrown, 'store_failed')
    }
  }

  async close(): Promise<void> {
    this.#db.close()
  }
}

export const openSqliteStore = async (options: StoreOptions): Promise<EventStore> => {
  const readOnly = options.readOnly === true
  const db = new Sqlite(options.path, { readOnly })
  const store = new SqliteEventStore(db, options.clock ?? systemClock, readOnly, options.strictProjection === true)
  try {
    // A writable handle brings its own schema up to date: `migrate` is
    // idempotent, and a reader never needs to write to open a store.
    if (!readOnly) await store.migrate()
  } catch (thrown) {
    await store.close()
    throw thrown
  }
  return store
}

/** What `apps/daemon` injects (§2). */
export const sqliteStoreFactory: StoreFactory = { open: openSqliteStore }
