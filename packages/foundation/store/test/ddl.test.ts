/**
 * The DDL is executed, not eyeballed (architecture §3, §11, §15). It proves the
 * schema is valid SQLite, that the constraints the design leans on are real, and
 * that applying the migration twice is a no-op. The store and the projections
 * that run on this schema are `sqlite-store.ts` and `projections.ts`.
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { LATEST_SCHEMA_VERSION, MIGRATIONS, SCHEMA_VERSION_1_SQL } from '../src/index.ts'

const fresh = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_VERSION_1_SQL)
  return db
}

/** The tables the design declares; SQLite's own `sqlite_*` bookkeeping is not one of them. */
const tableNames = (db: DatabaseSync): string[] =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name)

test('the schema applies to a fresh database, and applying the create statements again changes nothing', () => {
  const db = fresh()
  const before = tableNames(db)
  // Every `CREATE` is `IF NOT EXISTS`, so re-running them is a no-op. The
  // additive `ALTER TABLE ... ADD COLUMN` is deliberately not in this check:
  // SQLite has no `IF NOT EXISTS` for a column, and what makes it safe is the
  // version ledger — `store_meta` records it applied, so `migrate()` never
  // replays it (see `sqlite-store.ts`).
  db.exec(SCHEMA_VERSION_1_SQL.replace(/^ALTER TABLE .*$/gm, ''))
  assert.deepEqual(tableNames(db), before, 'every create is IF NOT EXISTS, so a re-apply is idempotent')
  db.close()
})

test('a fresh schema has the additive columns the migrations add on top of version 1', () => {
  const db = fresh()
  const columns = (db.prepare("SELECT name FROM pragma_table_info('messages')").all() as { name: string }[]).map(
    (row) => row.name,
  )
  // `SCHEMA_VERSION_1_SQL` is every migration's statements in order, so a fresh
  // database gets the table from version 1 and the column from version 5.
  assert.ok(columns.includes('delivered_session_id'), `messages has delivered_session_id; it has ${columns.join(', ')}`)
  db.close()
})

test('every table the design names exists', () => {
  const db = fresh()
  assert.deepEqual(tableNames(db), [
    'briefs',
    'builds',
    'contracts',
    'decisions',
    'eval_cases',
    'eval_runs',
    'events',
    'findings',
    'messages',
    'notifications',
    'peer_activity',
    'peer_compactions',
    'peer_failures',
    'peer_tool_counts',
    'peers',
    'projection_anomalies',
    'pull_requests',
    'routines',
    'sessions',
    'store_meta',
    'token_report',
    'work',
    'work_depends',
    'work_prs',
    'worktree_holders',
    'worktrees',
  ])
  db.close()
})

test('every table is STRICT, so a value of the wrong type is a write error and not a silent coercion', () => {
  const db = fresh()
  const strict = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string; sql: string }[]
  const loose = strict.filter((row) => !/\)\s*STRICT\s*;?\s*$/i.test(row.sql))
  assert.deepEqual(loose.map((row) => row.name), [])
  db.close()
})

test('events is append-only in practice: seq is assigned by the store', () => {
  const db = fresh()
  const insert = db.prepare('INSERT INTO events (ts, type, subject, actor, data) VALUES (?, ?, ?, ?, ?)')
  insert.run('2026-11-10T09:00:00.000Z', 'work.ready', 'wrk_7f3a91c2d84b0e56', 'pm', '{"workId":"wrk_7f3a91c2d84b0e56"}')
  insert.run('2026-11-10T09:01:00.000Z', 'work.assigned', 'wrk_7f3a91c2d84b0e56', 'pm', '{}')
  const seqs = (db.prepare('SELECT seq FROM events ORDER BY seq').all() as { seq: number }[]).map((row) => row.seq)
  assert.deepEqual(seqs, [1, 2])
  db.close()
})

test('the build ledger is unique on (repo, sha, task) — a second request appends nothing (§11)', () => {
  const db = fresh()
  const insert = db.prepare(
    'INSERT INTO builds (build_id, repo, sha, task, host, status, started_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const row = ['b1', 'backbase/me-services-fleet', '3ee0e67a1b2c3d4e', 'test', 'remote', 'running', '2026-11-10T09:00:00.000Z', '{}']
  insert.run(...row)
  assert.throws(() => insert.run('b2', ...row.slice(1)), /UNIQUE constraint failed/)
  db.close()
})

test('a finding is unique by fingerprint, so a re-run cannot duplicate it (§6.2)', () => {
  const db = fresh()
  const insert = db.prepare(
    `INSERT INTO findings (finding_id, fingerprint, tool, rule_id, severity, path, sha, state, seen_count, raised_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const row = ['f1', 'sha256:9a8b7c6d', 'semgrep', 'rule', 'high', 'src/a.ts', '3ee0e67', 'open', 1, '2026-11-10T09:00:00.000Z', '{}']
  insert.run(...row)
  assert.throws(() => insert.run('f2', ...row.slice(1)), /UNIQUE constraint failed/)
  db.close()
})

test('a STRICT table rejects a value that cannot be converted to the column type', () => {
  const db = fresh()
  // STRICT still permits a lossless INTEGER -> TEXT, but text in an INTEGER
  // column is a write error rather than the `0` a non-STRICT table would hold.
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO events (seq, ts, type, subject, actor, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run('not-a-number', '2026-11-10T09:00:00.000Z', 'work.ready', 's', 'pm', '{}'),
    /datatype mismatch/i,
  )
  db.close()
})

test('migrations are numbered from 1 with no gaps, and LATEST_SCHEMA_VERSION is the highest', () => {
  assert.deepEqual(
    MIGRATIONS.map((m) => m.version),
    MIGRATIONS.map((_, index) => index + 1),
  )
  assert.equal(LATEST_SCHEMA_VERSION, MIGRATIONS.at(-1)?.version)
  for (const migration of MIGRATIONS) assert.ok(migration.name.length > 0, `migration ${migration.version} is named`)
})

test('storage classes the schema relies on: timestamps and JSON blobs are TEXT', () => {
  const db = fresh()
  const columns = db.prepare("SELECT name, type FROM pragma_table_info('events')").all() as {
    name: string
    type: string
  }[]
  const byName = Object.fromEntries(columns.map((c) => [c.name, c.type]))
  assert.equal(byName.ts, 'TEXT')
  assert.equal(byName.data, 'TEXT')
  assert.equal(byName.seq, 'INTEGER')
  db.close()
})
