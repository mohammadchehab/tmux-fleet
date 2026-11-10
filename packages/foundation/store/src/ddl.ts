/**
 * The store's schema (architecture §3, §5.4, §15). The DDL and the migration
 * list; `sqlite-store.ts` applies it to a `node:sqlite` handle on open.
 *
 * Two rules shape the tables:
 * 1. `events` is the source of truth and is append-only. Every other table is
 *    a projection that can be dropped and rebuilt by replaying it.
 * 2. A projection table carries the columns the PM filters on, plus a `data`
 *    JSON column holding the whole typed row. The columns are for queries; the
 *    JSON is the row, so a projection never invents a shape the schema
 *    (foundation/contracts) does not have.
 */

export interface Migration {
  readonly version: number
  readonly name: string
  readonly statements: readonly string[]
}

const EVENTS = `
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL,
  type      TEXT    NOT NULL,
  subject   TEXT    NOT NULL,
  actor     TEXT    NOT NULL,
  caused_by TEXT,
  data      TEXT    NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS events_type    ON events (type);
CREATE INDEX IF NOT EXISTS events_subject ON events (subject);
`

const PEERS = `
CREATE TABLE IF NOT EXISTS peers (
  peer_id            TEXT PRIMARY KEY,
  role               TEXT NOT NULL,
  provider_id        TEXT NOT NULL,
  model              TEXT NOT NULL,
  permission_mode    TEXT NOT NULL,
  state              TEXT NOT NULL,
  brief_version      INTEGER NOT NULL,
  current_session_id TEXT,
  worktree_id        TEXT,
  registered_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS peers_state ON peers (state);

CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT PRIMARY KEY,
  peer_id              TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  provider_session_ref TEXT NOT NULL,
  resumed              INTEGER NOT NULL,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  end_reason           TEXT,
  data                 TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_peer ON sessions (peer_id);

CREATE TABLE IF NOT EXISTS peer_failures (
  seq      INTEGER PRIMARY KEY,
  peer_id  TEXT NOT NULL,
  reason   TEXT NOT NULL,
  retryable INTEGER NOT NULL,
  ts       TEXT NOT NULL
) STRICT;
`

const WORK = `
CREATE TABLE IF NOT EXISTS work (
  work_id        TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  state          TEXT NOT NULL,
  role           TEXT,
  assignee       TEXT,
  contract_id    TEXT,
  brief_id       TEXT,
  brief_version  INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  data           TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS work_state    ON work (state);
CREATE INDEX IF NOT EXISTS work_assignee ON work (assignee);

CREATE TABLE IF NOT EXISTS work_depends (
  work_id    TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (work_id, depends_on)
) STRICT;

CREATE TABLE IF NOT EXISTS work_prs (
  work_id TEXT NOT NULL,
  repo    TEXT NOT NULL,
  number  INTEGER NOT NULL,
  PRIMARY KEY (work_id, repo, number)
) STRICT;

CREATE TABLE IF NOT EXISTS contracts (
  contract_id  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  published    INTEGER NOT NULL,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  work_id      TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (contract_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS briefs (
  brief_id      TEXT PRIMARY KEY,
  work_id       TEXT NOT NULL,
  peer_id       TEXT NOT NULL,
  version       INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  superseded_by TEXT,
  data          TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS briefs_work ON briefs (work_id);
`

const DELIVERY = `
CREATE TABLE IF NOT EXISTS worktrees (
  worktree_id   TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  branch        TEXT NOT NULL,
  path          TEXT NOT NULL,
  owner_peer_id TEXT,
  class         TEXT NOT NULL,
  dirty         INTEGER NOT NULL,
  unpushed      INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  data          TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS worktrees_class  ON worktrees (class);
CREATE INDEX IF NOT EXISTS worktrees_owner  ON worktrees (owner_peer_id);

CREATE TABLE IF NOT EXISTS worktree_holders (
  worktree_id TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  command     TEXT,
  PRIMARY KEY (worktree_id, pid)
) STRICT;

CREATE TABLE IF NOT EXISTS pull_requests (
  repo         TEXT NOT NULL,
  number       INTEGER NOT NULL,
  base         TEXT NOT NULL,
  head         TEXT NOT NULL,
  head_sha     TEXT NOT NULL,
  checks       TEXT NOT NULL,
  review       TEXT NOT NULL,
  stack_parent TEXT,
  work_id      TEXT,
  merged       INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  data         TEXT NOT NULL,
  PRIMARY KEY (repo, number)
) STRICT;
CREATE INDEX IF NOT EXISTS pull_requests_work ON pull_requests (work_id);

CREATE TABLE IF NOT EXISTS builds (
  build_id    TEXT PRIMARY KEY,
  repo        TEXT NOT NULL,
  sha         TEXT NOT NULL,
  task        TEXT NOT NULL,
  host        TEXT NOT NULL,
  status      TEXT NOT NULL,
  log_path    TEXT,
  duration_ms INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  data        TEXT NOT NULL,
  UNIQUE (repo, sha, task)
) STRICT;
`

const OPS = `
CREATE TABLE IF NOT EXISTS decisions (
  decision_id  TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  state        TEXT NOT NULL,
  question     TEXT NOT NULL,
  inputs_hash  TEXT NOT NULL,
  judge_model  TEXT,
  work_id      TEXT,
  requested_at TEXT NOT NULL,
  answered_at  TEXT,
  data         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS decisions_state ON decisions (state);

CREATE TABLE IF NOT EXISTS routines (
  routine_id  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  state       TEXT NOT NULL,
  last_run_at TEXT,
  runs        INTEGER NOT NULL,
  failures    INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS notifications (
  key             TEXT PRIMARY KEY,
  class           TEXT NOT NULL,
  state           TEXT NOT NULL,
  channel         TEXT,
  delivery_failed INTEGER NOT NULL,
  occurrences     INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  reminded_at     TEXT,
  resolved_at     TEXT,
  data            TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS notifications_state ON notifications (state);

CREATE TABLE IF NOT EXISTS findings (
  finding_id  TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  tool        TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  severity    TEXT NOT NULL,
  path        TEXT NOT NULL,
  line        INTEGER,
  sha         TEXT NOT NULL,
  state       TEXT NOT NULL,
  seen_count  INTEGER NOT NULL,
  work_id     TEXT,
  decision_id TEXT,
  raised_at   TEXT NOT NULL,
  data        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS findings_state ON findings (state);

CREATE TABLE IF NOT EXISTS token_report (
  peer_id       TEXT NOT NULL,
  role          TEXT NOT NULL,
  -- '' is the rollup across every Work the peer has had; a turn before the
  -- first assignment has no Work to attribute itself to.
  work_id       TEXT NOT NULL DEFAULT '',
  turns         INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  grep          INTEGER NOT NULL,
  glob          INTEGER NOT NULL,
  read          INTEGER NOT NULL,
  codegraph     INTEGER NOT NULL,
  redirects     INTEGER NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (peer_id, role, work_id)
) STRICT;
`

const MAILBOX = `
CREATE TABLE IF NOT EXISTS messages (
  msg_id                TEXT PRIMARY KEY,
  to_peer               TEXT NOT NULL,
  from_actor            TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  brief_version         INTEGER NOT NULL,
  state                 TEXT NOT NULL,
  sent_at               TEXT NOT NULL,
  delivered_at          TEXT,
  acked_at              TEXT,
  current_brief_version INTEGER,
  body                  TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS messages_pending ON messages (to_peer, state);
`

const EVALS = `
CREATE TABLE IF NOT EXISTS eval_runs (
  run_id      TEXT PRIMARY KEY,
  suite       TEXT NOT NULL,
  sha         TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  state       TEXT NOT NULL,
  cases       INTEGER NOT NULL,
  passed      INTEGER,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cost_usd    REAL,
  latency_ms  INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  data        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS eval_runs_suite ON eval_runs (suite, started_at);

CREATE TABLE IF NOT EXISTS eval_cases (
  run_id     TEXT NOT NULL,
  case_id    TEXT NOT NULL,
  attempts   INTEGER NOT NULL,
  passes     INTEGER NOT NULL,
  pass       INTEGER NOT NULL,
  score      REAL NOT NULL,
  detail     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data       TEXT NOT NULL,
  PRIMARY KEY (run_id, case_id)
) STRICT;
`

const META = `
CREATE TABLE IF NOT EXISTS store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`

/**
 * An event about an entity the log never opened: the event stays in `events`, but
 * the projection had no row to write, and a silent drop would make a broken log
 * look like a healthy one. Keyed `(event_seq, projection)` — one row per event per
 * entity type — so a replay regenerates exactly the rows `append` recorded.
 */
const ANOMALIES = `
CREATE TABLE IF NOT EXISTS projection_anomalies (
  event_seq  INTEGER NOT NULL,
  projection TEXT    NOT NULL,
  event_type TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  detail     TEXT    NOT NULL,
  at         TEXT    NOT NULL,
  PRIMARY KEY (event_seq, projection)
) STRICT;
CREATE INDEX IF NOT EXISTS projection_anomalies_projection ON projection_anomalies (projection);
`

/**
 * Compactions, one row per `peer.compacted`. A separate table rather than a
 * counter on `peers`, because the count is read per peer *and* summed across the
 * fleet, and a peer's context can be rewritten more than once in a session (§8).
 */
const COMPACTIONS = `
CREATE TABLE IF NOT EXISTS peer_compactions (
  seq           INTEGER PRIMARY KEY,
  peer_id       TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  pre_tokens    INTEGER NOT NULL,
  -- The window the peer was configured with, kept beside the tokens it actually
  -- compacted at: a compaction well under the limit means the limit is wrong for
  -- the model. NULL when the provider cannot report one.
  context_limit INTEGER,
  ts            TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS peer_compactions_peer ON peer_compactions (peer_id);
`

/**
 * Migrations, in order. A store records the highest applied version in
 * `store_meta` and applies everything above it; version 1 is the initial
 * schema (architecture §3).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [EVENTS, PEERS, WORK, DELIVERY, OPS, MAILBOX, META],
  },
  {
    // additive: a projection of the log's own misses, so an upgraded store needs no backfill
    version: 2,
    name: 'projection_anomalies',
    statements: [ANOMALIES],
  },
  {
    // additive: eval results are new event types, so an existing log has nothing to backfill into them
    version: 3,
    name: 'evals',
    statements: [EVALS],
  },
  {
    // additive: compactions are new events too; a replay fills the table from the log
    version: 4,
    name: 'peer_compactions',
    statements: [COMPACTIONS],
  },
  {
    // additive: which session a delivery went to. `message.delivered` has always
    // carried it; the projection did not keep it, so the Mailbox held it in
    // memory and a fleetd restart lost it (§7). A row delivered before this
    // column existed reads `NULL`, which the Mailbox treats as "no session
    // recorded" and re-sends once — the at-least-once it already promised.
    version: 5,
    name: 'delivered_session_id',
    statements: ['ALTER TABLE messages ADD COLUMN delivered_session_id TEXT;'],
  },
  {
    // additive: the token report could count tokens but not price them, so
    // `fleet ls` had numbers and no bill (§6.2). `cost_usd` is what the turns
    // that published a price add up to; a row written before this column existed
    // reads 0, and so does a peer whose provider prices nothing.
    //
    // Added here rather than to `token_report`'s CREATE TABLE above, because a
    // fresh store applies the migrations in order too — the column has to come
    // from one place, not two.
    version: 6,
    name: 'token_cost',
    statements: ['ALTER TABLE token_report ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;'],
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/** Every statement, joined; what a test executes into a throwaway database. */
export const SCHEMA_VERSION_1_SQL = MIGRATIONS.flatMap((m) => m.statements).join('\n')
