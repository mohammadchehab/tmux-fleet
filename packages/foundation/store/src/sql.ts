/**
 * A thin, typed handle over `node:sqlite` (architecture §3, §15). The store is
 * one file per profile, written by the daemon and read by the CLI, so every
 * handle is opened in WAL mode with a busy timeout: a reader never blocks the
 * one writer for longer than a checkpoint.
 *
 * Statements are prepared once per SQL string and reused, which matters during a
 * `rebuild` that replays the whole log through the same few inserts.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite'

/** What SQLite accepts as a bound parameter. */
export type SqlValue = null | number | bigint | string | Uint8Array

export interface RunResult {
  readonly changes: number
  readonly lastInsertRowid: number
}

export class Sqlite {
  readonly #db: DatabaseSync
  readonly #statements = new Map<string, StatementSync>()
  #depth = 0

  constructor(path: string, options: { readonly readOnly?: boolean } = {}) {
    this.#db = new DatabaseSync(path, options.readOnly === true ? { readOnly: true } : {})
    if (options.readOnly !== true) {
      // WAL so `fleet ls` and `fleet replay` read while the daemon writes (§1.1).
      this.#db.exec('PRAGMA journal_mode = WAL')
      this.#db.exec('PRAGMA busy_timeout = 5000')
    }
  }

  #statement(sql: string): StatementSync {
    const cached = this.#statements.get(sql)
    if (cached !== undefined) return cached
    const prepared = this.#db.prepare(sql)
    this.#statements.set(sql, prepared)
    return prepared
  }

  exec(sql: string): void {
    this.#db.exec(sql)
  }

  run(sql: string, ...params: readonly SqlValue[]): RunResult {
    const result = this.#statement(sql).run(...params)
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
  }

  get<T>(sql: string, ...params: readonly SqlValue[]): T | undefined {
    return this.#statement(sql).get(...params) as T | undefined
  }

  all<T>(sql: string, ...params: readonly SqlValue[]): T[] {
    return this.#statement(sql).all(...params) as T[]
  }

  *iterate<T>(sql: string, ...params: readonly SqlValue[]): Generator<T> {
    yield* this.#statement(sql).iterate(...params) as IterableIterator<T>
  }

  /**
   * One transaction, re-entrant: `append` wraps the event inserts and the
   * projection writes in a single call, and a projector that opens its own is a
   * no-op rather than a nested `BEGIN` SQLite would reject.
   */
  transaction<T>(body: () => T): T {
    if (this.#depth > 0) return body()
    this.#db.exec('BEGIN IMMEDIATE')
    this.#depth = 1
    try {
      const value = body()
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    } finally {
      this.#depth = 0
    }
  }

  /**
   * The nightly copy under `store/backup/` (§1.1). `VACUUM INTO` writes a
   * consistent snapshot without stopping the daemon, and refuses to overwrite a
   * file — an existing backup is never silently replaced.
   */
  backup(targetPath: string): void {
    this.run('VACUUM INTO ?', targetPath)
  }

  close(): void {
    if (this.#db.isOpen !== false) this.#db.close()
  }
}
