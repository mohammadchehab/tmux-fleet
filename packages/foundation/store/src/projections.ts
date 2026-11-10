/**
 * The projections runner (architecture §3, §5.4). Every table except `events`
 * is a projection, and this is the only place one is written: `append` calls
 * `applyEvent` inside its transaction, and `rebuild` calls it for every stored
 * event from seq 1. Because both paths run the same reducer, a replay cannot
 * produce a different read model than the live write did.
 *
 * Two habits keep that true:
 * 1. A projection is a pure function of the events seen so far and the event's
 *    own `ts` — no clock, no filesystem, no network. The 6 h failure window and
 *    the quiet reminder belong to the `notify` routine (§6.1), which appends
 *    events; a projection only counts.
 * 2. A row is the schema's row, parsed before it is stored. A derived row that
 *    would not validate throws inside the append transaction, so a projection
 *    bug rolls the append back instead of writing a shape no reader can parse.
 */

import { parse, type Schema } from '@fleet/foundation-core'
import type { NotificationKey } from '@fleet/foundation-core'
import {
  PROJECTION_SCHEMAS,
  type Build,
  type Contract,
  type Decision,
  type EvalCase,
  type EvalRun,
  type Finding,
  type FleetEvent,
  type Holder,
  type JudgeQuestionRecord,
  type Message,
  type Notification,
  type Peer,
  type PullRequest,
  type PullRequestRef,
  type ReadModel,
  type Routine,
  type Session,
  type TokenReport,
  type Work,
  type Worktree,
} from '@fleet/foundation-contracts'
import type { Sqlite } from './sql.ts'

/**
 * Every table a replay drops first. `events` is deliberately absent: it is the
 * log being replayed, not a projection of it.
 */
export const PROJECTION_TABLES = [
  'peers',
  'sessions',
  'peer_failures',
  // Activity is dropped on replay like every other projection: `peer_tool_counts`
  // is a counter, so replaying it onto rows that survived would double every edit.
  'peer_activity',
  'peer_tool_counts',
  'work',
  'work_depends',
  'work_prs',
  'contracts',
  'briefs',
  'worktrees',
  'worktree_holders',
  'pull_requests',
  'builds',
  'decisions',
  'routines',
  'notifications',
  'findings',
  'judge_questions',
  'token_report',
  'messages',
  'eval_runs',
  'eval_cases',
  'projection_anomalies',
] as const

/**
 * An event about an entity the log never opened (§3, §5.4). `events` is append-only, so
 * the event stays; the projection simply has no row to write. Dropping it silently would
 * make a broken log look like a healthy one, so the miss becomes a row of its own, keyed
 * `(event seq, projection)`: a replay regenerates exactly what `append` recorded.
 *
 * This does not throw — a hand-written test log would otherwise fail inside `append`,
 * far from the assertion that explains it. `strictProjection` (the store's test mode) is
 * where a miss becomes fatal.
 */
export const recordAnomaly = (db: Sqlite, event: FleetEvent, projection: string, detail: string): void => {
  db.run(
    `INSERT OR REPLACE INTO projection_anomalies (event_seq, projection, event_type, subject, detail, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    event.seq,
    projection,
    event.type,
    event.subject,
    detail,
    event.ts,
  )
}

/** The one line every updater uses when its row is missing: the projection name, then the id. */
const missing = (db: Sqlite, event: FleetEvent, projection: string, id: string): void =>
  recordAnomaly(db, event, projection, `no ${projection} row for ${id}`)

export const clearProjections = (db: Sqlite): void => {
  for (const table of PROJECTION_TABLES) db.run(`DELETE FROM ${table}`)
}

// ------------------------------------------------------------------ row helpers

const json = <T>(schema: Schema<T>, text: unknown): T => parse(schema, JSON.parse(String(text)) as unknown)

/** The stored row for `key`, or `undefined`; the shape every updater starts from. */
const rowOf = <T>(db: Sqlite, schema: Schema<T>, table: string, column: string, key: string): T | undefined => {
  const row = db.get<{ data: string }>(`SELECT data FROM ${table} WHERE ${column} = ?`, key)
  return row === undefined ? undefined : json(schema, row.data)
}

const writeRow = (
  db: Sqlite,
  table: string,
  columns: readonly string[],
  values: readonly (string | number | null)[],
  keyColumns: readonly string[],
): void => {
  const placeholders = columns.map(() => '?').join(', ')
  const updates = columns
    .filter((column) => !keyColumns.includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(', ')
  db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(${keyColumns.join(', ')}) DO UPDATE SET ${updates}`,
    ...values,
  )
}

// ------------------------------------------------------------------------ peers

interface PeerRow {
  readonly peer_id: string
  readonly role: string
  readonly provider_id: string
  readonly model: string
  readonly permission_mode: string
  readonly state: string
  readonly brief_version: number
  readonly current_session_id: string | null
  readonly worktree_id: string | null
  readonly registered_at: string
  readonly updated_at: string
}

const peerFromRow = (row: PeerRow): Peer =>
  parse(PROJECTION_SCHEMAS.peer, {
    peerId: row.peer_id,
    role: row.role,
    providerId: row.provider_id,
    model: row.model,
    permissionMode: row.permission_mode,
    worktreeId: row.worktree_id ?? undefined,
    currentSessionId: row.current_session_id ?? undefined,
    briefVersion: Number(row.brief_version),
    state: row.state,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  })

export const peerById = (db: Sqlite, peerId: string): Peer | undefined => {
  const row = db.get<PeerRow>('SELECT * FROM peers WHERE peer_id = ?', peerId)
  return row === undefined ? undefined : peerFromRow(row)
}

const writePeer = (db: Sqlite, peer: Peer): void =>
  writeRow(
    db,
    'peers',
    [
      'peer_id',
      'role',
      'provider_id',
      'model',
      'permission_mode',
      'state',
      'brief_version',
      'current_session_id',
      'worktree_id',
      'registered_at',
      'updated_at',
    ],
    [
      peer.peerId,
      peer.role,
      peer.providerId,
      peer.model,
      peer.permissionMode,
      peer.state,
      peer.briefVersion,
      peer.currentSessionId ?? null,
      peer.worktreeId ?? null,
      peer.registeredAt,
      peer.updatedAt,
    ],
    ['peer_id'],
  )

/**
 * A `peer.*` event for a peer the log never registered leaves nothing to update.
 * That cannot happen in a store replayed from seq 1; it is tolerated so a
 * hand-written test log fails visibly at the assertion, not inside `append`.
 */
const updatePeer = (db: Sqlite, peerId: string, patch: Partial<Peer>, event: FleetEvent): Peer | undefined => {
  const current = peerById(db, peerId)
  if (current === undefined) {
    missing(db, event, 'peer', peerId)
    return undefined
  }
  const next = parse(PROJECTION_SCHEMAS.peer, { ...current, ...patch, updatedAt: event.ts })
  writePeer(db, next)
  return next
}

// --------------------------------------------------------------------- sessions

/**
 * The Work a peer is on right now: assigned to it and not finished (§5.1). The
 * same rule the PM's state snapshot uses, and the one a replay must apply, so
 * the Work an activity row is counted against is the Work the peer was actually
 * on when the call was made — read in log order, never from the clock.
 *
 * A peer can hold more than one open Work only if the PM broke its own rule;
 * the most recently touched one is what a reader means by "current".
 */
const currentWorkOf = (db: Sqlite, peerId: string): string | undefined =>
  db.get<{ work_id: string }>(
    `SELECT work_id FROM work
      WHERE assignee = ? AND state NOT IN ('cleaned', 'cancelled')
      ORDER BY updated_at DESC, work_id
      LIMIT 1`,
    peerId,
  )?.work_id

/**
 * The tools whose calls mean a Work is being *reworked* rather than explored.
 * Claude Code's names; a provider that calls its editor something else counts
 * nothing, which is the honest answer rather than a mapping this store invented
 * (§6.2's `countToolCall` makes the same choice).
 */
const editToolNames: readonly string[] = ['Edit', 'Write']

const writeSession = (db: Sqlite, session: Session): void =>
  writeRow(
    db,
    'sessions',
    [
      'session_id',
      'peer_id',
      'provider_id',
      'provider_session_ref',
      'resumed',
      'started_at',
      'ended_at',
      'end_reason',
      'data',
    ],
    [
      session.sessionId,
      session.peerId,
      session.providerId,
      session.providerSessionRef,
      session.resumed ? 1 : 0,
      session.startedAt,
      session.endedAt ?? null,
      session.endReason ?? null,
      JSON.stringify(session),
    ],
    ['session_id'],
  )

// ------------------------------------------------------------------------- work

const writeWork = (db: Sqlite, work: Work): void => {
  // `blockedOn` describes a blocked Work and nothing else. Dropping it here — the one
  // write every transition funnels through — means no handler can leave a stale "who
  // unblocks this" behind for the PM's `unblock` rule to route on.
  const row: Work = work.state === 'blocked' ? work : { ...work, blockedOn: undefined }
  writeRow(
    db,
    'work',
    [
      'work_id',
      'title',
      'state',
      'role',
      'assignee',
      'contract_id',
      'brief_id',
      'brief_version',
      'created_at',
      'updated_at',
      'data',
    ],
    [
      row.workId,
      row.title,
      row.state,
      row.role ?? null,
      row.assignee ?? null,
      row.contractId ?? null,
      row.briefId ?? null,
      row.briefVersion ?? null,
      row.createdAt,
      row.updatedAt,
      JSON.stringify(row),
    ],
    ['work_id'],
  )
  // The dependency and PR tables exist for the PM's queries; the JSON row is
  // still the work item, so they are rewritten from it rather than accumulated.
  db.run('DELETE FROM work_depends WHERE work_id = ?', work.workId)
  for (const dependency of work.dependsOn) {
    db.run('INSERT OR IGNORE INTO work_depends (work_id, depends_on) VALUES (?, ?)', work.workId, dependency)
  }
  db.run('DELETE FROM work_prs WHERE work_id = ?', work.workId)
  for (const pr of work.prs) {
    db.run('INSERT OR IGNORE INTO work_prs (work_id, repo, number) VALUES (?, ?, ?)', work.workId, pr.repo, pr.number)
  }
}

const workById = (db: Sqlite, workId: string): Work | undefined =>
  rowOf(db, PROJECTION_SCHEMAS.work, 'work', 'work_id', workId)

const updateWork = (db: Sqlite, workId: string, patch: Partial<Work>, event: FleetEvent): void => {
  const current = workById(db, workId)
  if (current === undefined) {
    missing(db, event, 'work', workId)
    return
  }
  writeWork(db, parse(PROJECTION_SCHEMAS.work, { ...current, ...patch, updatedAt: event.ts }))
}

/** Add a PR to a Work without duplicating one already recorded. */
const withPr = (current: Work, pr: PullRequestRef): Work['prs'] =>
  current.prs.some((known) => known.repo === pr.repo && known.number === pr.number)
    ? current.prs
    : [...current.prs, { repo: pr.repo, number: pr.number }]

const attachPr = (db: Sqlite, workId: string, pr: PullRequestRef, event: FleetEvent): void => {
  const current = workById(db, workId)
  if (current === undefined) {
    missing(db, event, 'work', workId)
    return
  }
  updateWork(db, workId, { prs: withPr(current, pr) }, event)
}

// ---------------------------------------------------------- contracts & briefs

const writeContract = (db: Sqlite, contract: Contract): void =>
  writeRow(
    db,
    'contracts',
    ['contract_id', 'version', 'published', 'path', 'content_hash', 'work_id', 'updated_at'],
    [
      contract.contractId,
      contract.version,
      contract.published ? 1 : 0,
      contract.path,
      contract.contentHash,
      contract.workId ?? null,
      contract.updatedAt,
    ],
    ['contract_id', 'version'],
  )

const briefById = (db: Sqlite, briefId: string) =>
  rowOf(db, PROJECTION_SCHEMAS.brief, 'briefs', 'brief_id', briefId)

// ------------------------------------------------------------ delivery: PRs etc

const pullRequestById = (db: Sqlite, repo: string, number: number): PullRequest | undefined => {
  const row = db.get<{ data: string }>(
    'SELECT data FROM pull_requests WHERE repo = ? AND number = ?',
    repo,
    number,
  )
  return row === undefined ? undefined : json(PROJECTION_SCHEMAS.pullRequest, row.data)
}

const writePullRequest = (db: Sqlite, pr: PullRequest): void =>
  writeRow(
    db,
    'pull_requests',
    [
      'repo',
      'number',
      'base',
      'head',
      'head_sha',
      'checks',
      'review',
      'stack_parent',
      'work_id',
      'merged',
      'created_at',
      'updated_at',
      'data',
    ],
    [
      pr.repo,
      pr.number,
      pr.base,
      pr.head,
      pr.headSha,
      pr.checks,
      pr.review,
      pr.stackParent === undefined ? null : `${pr.stackParent.repo}#${pr.stackParent.number}`,
      pr.workId ?? null,
      pr.merged ? 1 : 0,
      pr.createdAt,
      pr.updatedAt,
      JSON.stringify(pr),
    ],
    ['repo', 'number'],
  )

const updatePullRequest = (
  db: Sqlite,
  repo: string,
  number: number,
  patch: Partial<PullRequest>,
  event: FleetEvent,
): void => {
  const current = pullRequestById(db, repo, number)
  if (current === undefined) {
    missing(db, event, 'pull request', `${repo}#${number}`)
    return
  }
  writePullRequest(db, parse(PROJECTION_SCHEMAS.pullRequest, { ...current, ...patch, updatedAt: event.ts }))
}

const writeBuild = (db: Sqlite, build: Build): void =>
  writeRow(
    db,
    'builds',
    [
      'build_id',
      'repo',
      'sha',
      'task',
      'host',
      'status',
      'log_path',
      'duration_ms',
      'started_at',
      'finished_at',
      'data',
    ],
    [
      build.buildId,
      build.repo,
      build.sha,
      build.task,
      build.host,
      build.status,
      build.logPath ?? null,
      build.durationMs ?? null,
      build.startedAt,
      build.finishedAt ?? null,
      JSON.stringify(build),
    ],
    ['build_id'],
  )

const buildById = (db: Sqlite, buildId: string): Build | undefined =>
  rowOf(db, PROJECTION_SCHEMAS.build, 'builds', 'build_id', buildId)

/**
 * The dedupe read (§11). `builds` is `UNIQUE (repo, sha, task)`, so this is a
 * single indexed row and can never return two.
 */
const buildByKey = (db: Sqlite, repo: string, sha: string, task: string): Build | undefined => {
  const row = db.get<{ data: string }>('SELECT data FROM builds WHERE repo = ? AND sha = ? AND task = ?', repo, sha, task)
  return row === undefined ? undefined : json(PROJECTION_SCHEMAS.build, row.data)
}

const writeWorktree = (db: Sqlite, worktree: Worktree): void => {
  writeRow(
    db,
    'worktrees',
    [
      'worktree_id',
      'repo',
      'branch',
      'path',
      'owner_peer_id',
      'class',
      'dirty',
      'unpushed',
      'created_at',
      'updated_at',
      'data',
    ],
    [
      worktree.worktreeId,
      worktree.repo,
      worktree.branch,
      worktree.path,
      worktree.ownerPeerId ?? null,
      worktree.class,
      worktree.dirty ? 1 : 0,
      worktree.unpushed ? 1 : 0,
      worktree.createdAt,
      worktree.updatedAt,
      JSON.stringify(worktree),
    ],
    ['worktree_id'],
  )
  db.run('DELETE FROM worktree_holders WHERE worktree_id = ?', worktree.worktreeId)
  for (const holder of worktree.holders) {
    db.run(
      'INSERT OR IGNORE INTO worktree_holders (worktree_id, pid, command) VALUES (?, ?, ?)',
      worktree.worktreeId,
      holder.pid,
      holder.command ?? null,
    )
  }
}

const worktreeById = (db: Sqlite, worktreeId: string): Worktree | undefined =>
  rowOf(db, PROJECTION_SCHEMAS.worktree, 'worktrees', 'worktree_id', worktreeId)

// ---------------------------------------------------------------------- mailbox

interface MessageRow {
  readonly msg_id: string
  readonly to_peer: string
  readonly from_actor: string
  readonly kind: string
  readonly brief_version: number
  readonly state: string
  readonly sent_at: string
  readonly delivered_at: string | null
  readonly delivered_session_id: string | null
  readonly acked_at: string | null
  readonly current_brief_version: number | null
  readonly body: string
}

export const messageFromRow = (row: MessageRow): Message =>
  parse(PROJECTION_SCHEMAS.message, {
    msgId: row.msg_id,
    to: row.to_peer,
    from: row.from_actor,
    kind: row.kind,
    briefVersion: Number(row.brief_version),
    body: row.body,
    state: row.state,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at ?? undefined,
    deliveredSessionId: row.delivered_session_id ?? undefined,
    ackedAt: row.acked_at ?? undefined,
    currentBriefVersion: row.current_brief_version ?? undefined,
  })

export const messageById = (db: Sqlite, msgId: string): Message | undefined => {
  const row = db.get<MessageRow>('SELECT * FROM messages WHERE msg_id = ?', msgId)
  return row === undefined ? undefined : messageFromRow(row)
}

const updateMessage = (db: Sqlite, msgId: string, patch: Partial<Message>, event: FleetEvent): void => {
  const current = messageById(db, msgId)
  if (current === undefined) {
    missing(db, event, 'message', msgId)
    return
  }
  const next = parse(PROJECTION_SCHEMAS.message, { ...current, ...patch })
  writeRow(
    db,
    'messages',
    [
      'msg_id',
      'to_peer',
      'from_actor',
      'kind',
      'brief_version',
      'state',
      'sent_at',
      'delivered_at',
      'delivered_session_id',
      'acked_at',
      'current_brief_version',
      'body',
    ],
    [
      next.msgId,
      next.to,
      next.from,
      next.kind,
      next.briefVersion,
      next.state,
      next.sentAt,
      next.deliveredAt ?? null,
      next.deliveredSessionId ?? null,
      next.ackedAt ?? null,
      next.currentBriefVersion ?? null,
      next.body,
    ],
    ['msg_id'],
  )
}

// ------------------------------------------------------------------------ ops

const writeDecision = (db: Sqlite, decision: Decision): void =>
  writeRow(
    db,
    'decisions',
    [
      'decision_id',
      'kind',
      'state',
      'question',
      'inputs_hash',
      'judge_model',
      'work_id',
      'requested_at',
      'answered_at',
      'data',
    ],
    [
      decision.decisionId,
      decision.kind,
      decision.state,
      decision.question,
      decision.inputsHash,
      decision.judgeModel ?? null,
      decision.workId ?? null,
      decision.requestedAt,
      decision.answeredAt ?? null,
      JSON.stringify(decision),
    ],
    ['decision_id'],
  )

const decisionById = (db: Sqlite, decisionId: string): Decision | undefined =>
  rowOf(db, PROJECTION_SCHEMAS.decision, 'decisions', 'decision_id', decisionId)

interface RoutineRow {
  readonly routine_id: string
  readonly kind: string
  readonly trigger_kind: string
  readonly state: string
  readonly last_run_at: string | null
  readonly runs: number
  readonly failures: number
}

export const routineFromRow = (row: RoutineRow): Routine =>
  parse(PROJECTION_SCHEMAS.routine, {
    routineId: row.routine_id,
    kind: row.kind,
    trigger: row.trigger_kind,
    state: row.state,
    lastRunAt: row.last_run_at ?? undefined,
    runs: Number(row.runs),
    failures: Number(row.failures),
  })

const routineById = (db: Sqlite, routineId: string): Routine | undefined => {
  const row = db.get<RoutineRow>('SELECT * FROM routines WHERE routine_id = ?', routineId)
  return row === undefined ? undefined : routineFromRow(row)
}

const writeRoutine = (db: Sqlite, routine: Routine): void =>
  writeRow(
    db,
    'routines',
    ['routine_id', 'kind', 'trigger_kind', 'state', 'last_run_at', 'runs', 'failures'],
    [
      routine.routineId,
      routine.kind,
      routine.trigger,
      routine.state,
      routine.lastRunAt ?? null,
      routine.runs,
      routine.failures,
    ],
    ['routine_id'],
  )

const updateRoutine = (db: Sqlite, routineId: string, patch: Partial<Routine>, event: FleetEvent): void => {
  const current = routineById(db, routineId)
  if (current === undefined) {
    missing(db, event, 'routine', routineId)
    return
  }
  writeRoutine(db, parse(PROJECTION_SCHEMAS.routine, { ...current, ...patch }))
}

const writeNotification = (db: Sqlite, notification: Notification): void =>
  writeRow(
    db,
    'notifications',
    [
      'key',
      'class',
      'state',
      'channel',
      'delivery_failed',
      'occurrences',
      'created_at',
      'sent_at',
      'reminded_at',
      'resolved_at',
      'data',
    ],
    [
      notification.key,
      notification.class,
      notification.state,
      notification.channel ?? null,
      notification.deliveryFailed ? 1 : 0,
      notification.occurrences,
      notification.createdAt,
      notification.sentAt ?? null,
      notification.remindedAt ?? null,
      notification.resolvedAt ?? null,
      // `withdrawnAt` rides in `data` only: nothing queries it, and the columns are for what a query needs.
      JSON.stringify(notification),
    ],
    ['key'],
  )

const notificationByKey = (db: Sqlite, key: string): Notification | undefined =>
  rowOf(db, PROJECTION_SCHEMAS.notification, 'notifications', 'key', key)

/** A key is `decision:<id>`, `failure:<subject>:<kind>` or `standup:<date>`; anything a
 * subject carries that the key pattern does not allow (a space, a `/`) is folded to `-`. */
const keyPart = (value: string): string => value.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 60)
const notificationKeyOf = (prefix: 'decision' | 'failure' | 'standup', ...parts: readonly string[]): NotificationKey =>
  `${prefix}:${parts.map(keyPart).join(':')}` as NotificationKey

/** The key a broken routine raises and a recovered one resolves (§6.1's `failure` class). */
const routineFailureKey = (routineId: string, kind: string): NotificationKey =>
  notificationKeyOf('failure', routineId, kind)

/**
 * The projection's half of §6.1: one row per key, and a recurrence bumps
 * `occurrences` instead of opening a second row. Whether a recurrence is worth
 * a second banner (once per 6 h) is the `notify` routine's rule, not the store's.
 */
const raiseNotification = (
  db: Sqlite,
  key: NotificationKey,
  notificationClass: Notification['class'],
  ts: string,
  /**
   * What the banner should say, when the projection knows more than the key does.
   * A key carries a subject and a kind; a compaction carries numbers, and a
   * banner that says "compacted" without them is the shrug this event exists to
   * replace (§6.1, §8). Left out, the `notify` routine renders from the key.
   */
  detail?: { readonly title?: string; readonly body?: string },
): void => {
  const current = notificationByKey(db, key)
  if (current === undefined) {
    writeNotification(
      db,
      parse(PROJECTION_SCHEMAS.notification, {
        key,
        class: notificationClass,
        state: 'pending',
        deliveryFailed: false,
        occurrences: 1,
        createdAt: ts,
        ...(detail?.title === undefined ? {} : { title: detail.title }),
        ...(detail?.body === undefined ? {} : { body: detail.body }),
      }),
    )
    return
  }
  writeNotification(
    db,
    parse(PROJECTION_SCHEMAS.notification, {
      ...current,
      class: notificationClass,
      occurrences: current.occurrences + 1,
    }),
  )
}

/** Thousands separators, for a number a person reads on a lock screen. */
const tokenText = (tokens: number): string => tokens.toLocaleString('en-US')

/**
 * What a compaction banner says (§6.1, §8).
 *
 * The comparison is the point. A compaction at a number well under the window
 * the peer was *configured* with means the provider gave up long before the
 * fleet's ratio could fire, and the fix is the profile's `contextLimit`, not a
 * tighter purge — so the banner says which of the two it is, using the pair the
 * event carries. With no configured limit to compare against it says only what
 * it knows, rather than guessing at a verdict.
 */
const compactionDetail = (
  peerId: string,
  model: string | undefined,
  trigger: string,
  preTokens: number,
  contextLimit: number | undefined,
): { readonly title: string; readonly body: string } => {
  const who = model === undefined ? String(peerId) : `${String(peerId)} (${model})`
  const compacted = `compacted ${tokenText(preTokens)} tokens (${trigger})`
  const title = `Compaction: ${String(peerId)}`
  if (contextLimit === undefined) {
    return { title, body: `${who} — ${compacted}. The provider reported no context limit, so there is nothing to compare it against.` }
  }
  return {
    title,
    body:
      preTokens < contextLimit
        ? `${who} — ${compacted} under a configured limit of ${tokenText(contextLimit)}. The configured limit is too high for this model: the provider compacted well before the purge could fire.`
        : `${who} — ${compacted} against a configured limit of ${tokenText(contextLimit)}. The limit fits this model; the purge simply did not get there first.`,
  }
}

const resolveNotification = (db: Sqlite, key: NotificationKey, ts: string): void => {
  const current = notificationByKey(db, key)
  if (current === undefined || current.state === 'resolved') return
  writeNotification(db, parse(PROJECTION_SCHEMAS.notification, { ...current, state: 'resolved', resolvedAt: ts }))
}

const JUDGE_QUESTION_COLUMNS = [
  'question_id',
  'kind',
  'inputs_hash',
  'work_id',
  'asked_for',
  'asked_at',
  'answered_at',
  'model',
  'data',
] as const

const writeJudgeQuestion = (db: Sqlite, question: JudgeQuestionRecord): void => {
  writeRow(
    db,
    'judge_questions',
    JUDGE_QUESTION_COLUMNS,
    [
      question.questionId,
      question.kind,
      question.inputsHash,
      question.workId ?? null,
      question.askedFor ?? null,
      question.askedAt,
      question.answeredAt ?? null,
      question.model ?? null,
      JSON.stringify(question),
    ],
    ['question_id'],
  )
}

const judgeQuestionById = (db: Sqlite, id: string): JudgeQuestionRecord | undefined => {
  const row = db.get<{ data: string }>('SELECT data FROM judge_questions WHERE question_id = ?', id)
  return row === undefined ? undefined : json(PROJECTION_SCHEMAS.judgeQuestion, row.data)
}

const writeFinding = (db: Sqlite, finding: Finding): void =>
  writeRow(
    db,
    'findings',
    [
      'finding_id',
      'fingerprint',
      'tool',
      'rule_id',
      'severity',
      'path',
      'line',
      'sha',
      'state',
      'seen_count',
      'work_id',
      'decision_id',
      'raised_at',
      'data',
    ],
    [
      finding.findingId,
      finding.fingerprint,
      finding.tool,
      finding.ruleId,
      finding.severity,
      finding.path,
      finding.line ?? null,
      finding.sha,
      finding.state,
      finding.seenCount,
      finding.workId ?? null,
      finding.decisionId ?? null,
      finding.raisedAt,
      JSON.stringify(finding),
    ],
    ['finding_id'],
  )

const findingById = (db: Sqlite, findingId: string): Finding | undefined =>
  rowOf(db, PROJECTION_SCHEMAS.finding, 'findings', 'finding_id', findingId)

/** §6.2: a fingerprint is stable across line shifts, so a re-raise updates the row it names. */
const findingByFingerprint = (db: Sqlite, fingerprint: string): Finding | undefined => {
  const row = db.get<{ data: string }>('SELECT data FROM findings WHERE fingerprint = ?', fingerprint)
  return row === undefined ? undefined : json(PROJECTION_SCHEMAS.finding, row.data)
}

// ---------------------------------------------------------------- token report

interface TokenRow {
  readonly peer_id: string
  readonly role: string
  readonly work_id: string
  readonly turns: number
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cached_tokens: number
  readonly cost_usd: number
  readonly grep: number
  readonly glob: number
  readonly read: number
  readonly codegraph: number
  readonly redirects: number
  readonly updated_at: string
}

const tokenReportFromRow = (row: TokenRow): TokenReport =>
  parse(PROJECTION_SCHEMAS.tokenReport, {
    peerId: row.peer_id,
    role: row.role,
    workId: row.work_id === '' ? undefined : row.work_id,
    turns: Number(row.turns),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cachedTokens: Number(row.cached_tokens),
    costUsd: Number(row.cost_usd),
    toolCalls: {
      grep: Number(row.grep),
      glob: Number(row.glob),
      read: Number(row.read),
      codegraph: Number(row.codegraph),
    },
    redirects: Number(row.redirects),
    updatedAt: row.updated_at,
  })

const writeTokenReport = (db: Sqlite, report: TokenReport): void =>
  writeRow(
    db,
    'token_report',
    [
      'peer_id',
      'role',
      'work_id',
      'turns',
      'input_tokens',
      'output_tokens',
      'cached_tokens',
      'cost_usd',
      'grep',
      'glob',
      'read',
      'codegraph',
      'redirects',
      'updated_at',
    ],
    [
      report.peerId,
      report.role,
      report.workId ?? '',
      report.turns,
      report.inputTokens,
      report.outputTokens,
      report.cachedTokens,
      report.costUsd,
      report.toolCalls.grep,
      report.toolCalls.glob,
      report.toolCalls.read,
      report.toolCalls.codegraph,
      report.redirects,
      report.updatedAt,
    ],
    ['peer_id', 'role', 'work_id'],
  )

const tokenReportFor = (db: Sqlite, peerId: string, role: string, workId: string): TokenReport => {
  const row = db.get<TokenRow>(
    'SELECT * FROM token_report WHERE peer_id = ? AND role = ? AND work_id = ?',
    peerId,
    role,
    workId,
  )
  return (
    row === undefined
      ? parse(PROJECTION_SCHEMAS.tokenReport, {
          peerId,
          role,
          workId: workId === '' ? undefined : workId,
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          toolCalls: { grep: 0, glob: 0, read: 0, codegraph: 0 },
          redirects: 0,
          updatedAt: new Date(0).toISOString(),
        })
      : tokenReportFromRow(row)
  )
}

// ------------------------------------------------------------------- the reducer

/**
 * The one place a projection row is written (§3, §5.4). Called inside `append`'s
 * transaction and, for every stored event in order, by `rebuild`.
 */
export const applyEvent = (db: Sqlite, event: FleetEvent): void => {
  const ts = event.ts

  switch (event.type) {
    // ---------------------------------------------------------------- peers
    case 'peer.registered': {
      const { peerId, role, providerId, model, permissionMode, worktreeId } = event.data
      writePeer(
        db,
        parse(PROJECTION_SCHEMAS.peer, {
          peerId,
          role,
          providerId,
          model,
          permissionMode,
          worktreeId,
          // 0 is "no brief yet": the Mailbox reads `undefined` until one is published (§7, §12).
          briefVersion: 0,
          state: 'starting',
          registeredAt: ts,
          updatedAt: ts,
        }),
      )
      return
    }
    case 'peer.standards_set': {
      const { peerId, version } = event.data
      const current = peerById(db, peerId)
      // A version only goes up (§12.1): the Mailbox rejects mail citing an older
      // one, so a lower or equal one would un-reject what it just rejected.
      if (current !== undefined && version <= current.briefVersion) {
        recordAnomaly(db, event, 'peer', `standards version ${String(version)} does not exceed ${String(current.briefVersion)} for ${peerId}`)
        return
      }
      updatePeer(db, peerId, { briefVersion: version }, event)
      return
    }
    case 'peer.state_changed': {
      const { peerId, state, sessionId } = event.data
      updatePeer(db, peerId, sessionId === undefined ? { state } : { state, currentSessionId: sessionId }, event)
      return
    }
    case 'peer.failed': {
      const { peerId, sessionId, reason, retryable } = event.data
      db.run(
        'INSERT OR REPLACE INTO peer_failures (seq, peer_id, reason, retryable, ts) VALUES (?, ?, ?, ?, ?)',
        event.seq,
        peerId,
        reason,
        retryable ? 1 : 0,
        ts,
      )
      updatePeer(
        db,
        peerId,
        sessionId === undefined ? { state: 'failed' } : { state: 'failed', currentSessionId: sessionId },
        event,
      )
      // §6.1 `failure`: a crash, a session that will not resume, a config mismatch.
      raiseNotification(db, notificationKeyOf('failure', peerId, reason), 'failure', ts)
      return
    }
    case 'peer.tool_used': {
      const { peerId, tool, target } = event.data
      if (peerById(db, peerId) === undefined) {
        missing(db, event, 'peer', peerId)
        return
      }
      // Last-write-wins for "what is it doing": the newest call is the answer, and
      // the target is cleared when the newest call had none, so a provider that
      // does not summarise does not leave the previous tool's path looking current.
      db.run(
        `INSERT INTO peer_activity (peer_id, last_tool, last_target, last_tool_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (peer_id) DO UPDATE SET
           last_tool = excluded.last_tool,
           last_target = excluded.last_target,
           last_tool_at = excluded.last_tool_at`,
        peerId,
        tool,
        target ?? null,
        ts,
      )
      // Only an edit against a Work is counted, and only against the Work the peer
      // was on at this point in the log: a call with no current Work is activity
      // (the row above) but not rework of anything.
      if (!editToolNames.includes(tool)) return
      const workId = currentWorkOf(db, peerId)
      if (workId === undefined) return
      db.run(
        `INSERT INTO peer_tool_counts (peer_id, work_id, tool, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (peer_id, work_id, tool) DO UPDATE SET count = peer_tool_counts.count + 1`,
        peerId,
        workId,
        tool,
      )
      return
    }
    case 'peer.compacted': {
      const { peerId, trigger, preTokens, contextLimit } = event.data
      db.run(
        `INSERT OR REPLACE INTO peer_compactions (seq, peer_id, trigger, pre_tokens, context_limit, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
        event.seq,
        peerId,
        trigger,
        preTokens,
        contextLimit ?? null,
        ts,
      )
      // §6.1 `failure`: a compaction is not a routine step. It rewrites the peer's
      // context and bills for re-reading it, and the whole point of the alert is
      // that nobody would otherwise notice. Keyed by the event, not the peer, so
      // two compactions are two notifications rather than one that deduped away.
      const model = db.get<{ model: string }>('SELECT model FROM peers WHERE peer_id = ?', peerId)?.model
      raiseNotification(
        db,
        notificationKeyOf('failure', peerId, 'compacted', String(event.seq)),
        'failure',
        ts,
        compactionDetail(peerId, model, trigger, preTokens, contextLimit),
      )
      return
    }
    case 'session.started': {
      const { peerId, sessionId, providerId, providerSessionRef, model, permissionMode, resumed } = event.data
      writeSession(
        db,
        parse(PROJECTION_SCHEMAS.session, {
          sessionId,
          peerId,
          providerId,
          providerSessionRef,
          model,
          permissionMode,
          resumed,
          startedAt: ts,
        }),
      )
      updatePeer(db, peerId, { currentSessionId: sessionId }, event)
      return
    }
    case 'session.ended': {
      const { peerId, sessionId, endReason } = event.data
      const row = db.get<{ data: string }>('SELECT data FROM sessions WHERE session_id = ?', sessionId)
      if (row !== undefined) {
        const session = json(PROJECTION_SCHEMAS.session, row.data)
        writeSession(
          db,
          parse(PROJECTION_SCHEMAS.session, { ...session, endedAt: ts, endReason }),
        )
      }
      const peer = peerById(db, peerId)
      if (peer?.currentSessionId === sessionId) updatePeer(db, peerId, { currentSessionId: undefined }, event)
      return
    }
    case 'provider.errored': {
      const { peerId, code } = event.data
      raiseNotification(db, notificationKeyOf('failure', peerId, code), 'failure', ts)
      return
    }

    // ------------------------------------------------------------------ work
    case 'work.proposed': {
      const { workId, title, role, body, contractId, dependsOn, external } = event.data
      writeWork(
        db,
        parse(PROJECTION_SCHEMAS.work, {
          workId,
          title,
          state: 'proposed',
          role,
          body,
          contractId,
          dependsOn,
          prs: [],
          external,
          createdAt: ts,
          updatedAt: ts,
        }),
      )
      return
    }
    case 'work.contract_needed':
      updateWork(db, event.data.workId, { state: 'needs_contract', contractId: event.data.contractId }, event)
      return
    case 'work.ready':
      updateWork(db, event.data.workId, { state: 'ready' }, event)
      return
    case 'work.assigned': {
      const { workId, peerId, briefId, briefVersion } = event.data
      updateWork(db, workId, { state: 'assigned', assignee: peerId, briefId, briefVersion }, event)
      return
    }
    case 'work.started':
      updateWork(db, event.data.workId, { state: 'in_progress', assignee: event.data.peerId }, event)
      return
    case 'work.review_requested': {
      const { workId, pr } = event.data
      const current = workById(db, workId)
      if (current === undefined) {
        missing(db, event, 'work', workId)
        return
      }
      writeWork(
        db,
        parse(PROJECTION_SCHEMAS.work, {
          ...current,
          state: 'in_review',
          prs: pr === undefined ? current.prs : withPr(current, pr),
          updatedAt: ts,
        }),
      )
      return
    }
    case 'work.mergeable':
    case 'work.merged': {
      const { workId, pr } = event.data
      const state = event.type === 'work.mergeable' ? 'mergeable' : 'merged'
      const current = workById(db, workId)
      if (current === undefined) {
        missing(db, event, 'work', workId)
        return
      }
      writeWork(
        db,
        parse(PROJECTION_SCHEMAS.work, { ...current, state, prs: withPr(current, pr), updatedAt: ts }),
      )
      return
    }
    case 'work.cleaned': {
      const current = workById(db, event.data.workId)
      if (current === undefined) {
        missing(db, event, 'work', event.data.workId)
        return
      }
      // `cleaned` is the last step of §5.1's forward path, and only a merged Work has
      // a path to it. Writing it unconditionally would move a `cancelled` Work —
      // somebody's "drop this" — to `cleaned`, a decision the log never recorded and
      // the collector was never asked to make. A producer that emits on `merged`
      // alone (`branch-cleanup` does) is refused here instead, and refused loudly:
      // the anomaly is a row, so a replay regenerates it and a reader can see it.
      if (current.state === 'cleaned') return
      if (current.state !== 'merged') {
        recordAnomaly(db, event, 'work', `refused work.cleaned: state is ${current.state}, not merged`)
        return
      }
      updateWork(db, event.data.workId, { state: 'cleaned' }, event)
      return
    }
    case 'work.blocked':
      updateWork(
        db,
        event.data.workId,
        { state: 'blocked', blockedReason: event.data.reason, blockedOn: event.data.blockedOn },
        event,
      )
      return
    case 'work.cancelled':
      updateWork(db, event.data.workId, { state: 'cancelled', blockedReason: event.data.reason }, event)
      return

    // --------------------------------------------- contracts, briefs, delivery
    case 'contract.published': {
      const { contractId, version, path, contentHash, workId } = event.data
      writeContract(
        db,
        parse(PROJECTION_SCHEMAS.contract, {
          contractId,
          version,
          published: true,
          path,
          contentHash,
          workId,
          updatedAt: ts,
        }),
      )
      return
    }
    case 'brief.published': {
      const { briefId, workId, peerId, version, contractVersions, text } = event.data
      writeRow(
        db,
        'briefs',
        ['brief_id', 'work_id', 'peer_id', 'version', 'created_at', 'superseded_by', 'data'],
        [
          briefId,
          workId,
          peerId,
          version,
          ts,
          null,
          JSON.stringify(
            parse(PROJECTION_SCHEMAS.brief, {
              briefId,
              workId,
              peerId,
              version,
              contractVersions,
              text,
              createdAt: ts,
            }),
          ),
        ],
        ['brief_id'],
      )
      // The peer's context now carries this version; the Mailbox compares against it (§7).
      updatePeer(db, peerId, { briefVersion: version }, event)
      // And the Work's current brief moves with it, so the `stale` rule (§5.2) compares against the brief
      // actually published, not the one `work.assigned` first named. A no-op for a Work that does not exist.
      updateWork(db, workId, { briefId, briefVersion: version }, event)
      return
    }
    case 'brief.superseded': {
      const { briefId, supersededBy } = event.data
      const current = briefById(db, briefId)
      if (current === undefined) {
        missing(db, event, 'brief', briefId)
        return
      }
      const next = parse(PROJECTION_SCHEMAS.brief, { ...current, supersededBy })
      writeRow(
        db,
        'briefs',
        ['brief_id', 'work_id', 'peer_id', 'version', 'created_at', 'superseded_by', 'data'],
        [next.briefId, next.workId, next.peerId, next.version, next.createdAt, supersededBy, JSON.stringify(next)],
        ['brief_id'],
      )
      return
    }
    case 'pr.opened': {
      const { pr, base, head, headSha, workId, stackParent } = event.data
      writePullRequest(
        db,
        parse(PROJECTION_SCHEMAS.pullRequest, {
          repo: pr.repo,
          number: pr.number,
          base,
          head,
          headSha,
          checks: 'pending',
          failingChecks: [],
          review: 'pending',
          stackParent,
          workId,
          merged: false,
          createdAt: ts,
          updatedAt: ts,
        }),
      )
      if (workId !== undefined) attachPr(db, workId, pr, event)
      return
    }
    case 'pr.checks_changed': {
      const { pr, headSha, state, failing } = event.data
      updatePullRequest(db, pr.repo, pr.number, { headSha, checks: state, failingChecks: failing }, event)
      return
    }
    case 'pr.review_changed': {
      const { pr, headSha, state } = event.data
      updatePullRequest(db, pr.repo, pr.number, { headSha, review: state }, event)
      return
    }
    case 'pr.merged': {
      const { pr, headSha } = event.data
      updatePullRequest(db, pr.repo, pr.number, { headSha, merged: true }, event)
      return
    }
    case 'pr.retargeted': {
      const { pr, toBase } = event.data
      updatePullRequest(db, pr.repo, pr.number, { base: toBase }, event)
      return
    }
    case 'ci.failed_final': {
      const { pr, headSha, check } = event.data
      const current = pullRequestById(db, pr.repo, pr.number)
      const failing = current?.failingChecks.includes(check) === true ? current.failingChecks : [...(current?.failingChecks ?? []), check]
      updatePullRequest(db, pr.repo, pr.number, { headSha, checks: 'failing', failingChecks: failing }, event)
      raiseNotification(db, notificationKeyOf('failure', `${pr.repo}#${pr.number}`, check), 'failure', ts)
      return
    }
    case 'build.requested': {
      const { buildId, repo, sha, task, host } = event.data
      writeBuild(
        db,
        parse(PROJECTION_SCHEMAS.build, {
          buildId,
          repo,
          sha,
          task,
          host,
          status: 'running',
          startedAt: ts,
        }),
      )
      return
    }
    case 'build.finished': {
      const { buildId, status, logPath, durationMs } = event.data
      const current = buildById(db, buildId)
      // The ledger is keyed on `(repo, sha, task)` and the request carries them;
      // a finish with no request in the log has nothing to complete.
      if (current === undefined) {
        missing(db, event, 'build', buildId)
        return
      }
      writeBuild(
        db,
        parse(PROJECTION_SCHEMAS.build, {
          ...current,
          status,
          logPath,
          durationMs,
          finishedAt: ts,
        }),
      )
      return
    }

    // --------------------------------------------------------------- mailbox
    case 'message.sent': {
      const { msgId, to, from, kind, briefVersion, body } = event.data
      const message = parse(PROJECTION_SCHEMAS.message, {
        msgId,
        to,
        from,
        kind,
        briefVersion,
        body,
        state: 'pending',
        sentAt: ts,
      })
      writeRow(
        db,
        'messages',
        [
          'msg_id',
          'to_peer',
          'from_actor',
          'kind',
          'brief_version',
          'state',
          'sent_at',
          'delivered_at',
          'delivered_session_id',
          'acked_at',
          'current_brief_version',
          'body',
        ],
        [
          message.msgId,
          message.to,
          message.from,
          message.kind,
          message.briefVersion,
          message.state,
          message.sentAt,
          null,
          null,
          null,
          null,
          message.body,
        ],
        ['msg_id'],
      )
      return
    }
    case 'message.delivered':
      updateMessage(
        db,
        event.data.msgId,
        { state: 'delivered', deliveredAt: ts, deliveredSessionId: event.data.sessionId },
        event,
      )
      return
    case 'message.acked':
      updateMessage(db, event.data.msgId, { state: 'acked', ackedAt: ts }, event)
      return
    case 'message.rejected':
      updateMessage(db, event.data.msgId, {
        state: 'rejected',
        currentBriefVersion: event.data.currentBriefVersion,
      }, event)
      return

    // ------------------------------------------------- routines and worktrees
    case 'routine.started': {
      const { routineId, kind, trigger } = event.data
      const current = routineById(db, routineId)
      writeRoutine(
        db,
        parse(PROJECTION_SCHEMAS.routine, {
          routineId,
          kind,
          trigger,
          state: 'running',
          lastRunAt: ts,
          runs: (current?.runs ?? 0) + 1,
          failures: current?.failures ?? 0,
        }),
      )
      return
    }
    case 'routine.finished':
      updateRoutine(db, event.data.routineId, { state: 'finished', lastRunAt: ts }, event)
      // A routine that finished has recovered, so its failure banner has nothing
      // left to say: resolve it and §6.1's close rule withdraws it (§6, §6.1).
      resolveNotification(db, routineFailureKey(event.data.routineId, event.data.kind), ts)
      return
    case 'routine.failed': {
      const routineId = event.data.routineId
      const current = routineById(db, routineId)
      updateRoutine(db, routineId, {
        state: 'failed',
        lastRunAt: ts,
        failures: (current?.failures ?? 0) + 1,
      }, event)
      return
    }
    /**
     * §6.1's `failure` class, raised by the scheduler when it decides a routine is
     * broken rather than unlucky. The row carries its own words because the key
     * cannot: `failure:<routine>:<kind>` says which routine, and nothing about
     * what broke or when it will be tried again, which is exactly what a person
     * needs to decide whether to care.
     */
    case 'routine.failing': {
      const { routineId, kind, error, failures, retryAt } = event.data
      raiseNotification(db, routineFailureKey(routineId, kind), 'failure', ts, {
        title: `Routine ${routineId} keeps failing`,
        body: `${error}\n\n${failures} attempts in a row have failed. The next retry is ${retryAt}.`,
      })
      return
    }
    case 'worktree.created': {
      const { worktreeId, repo, branch, path, ownerPeerId, class: worktreeClass } = event.data
      writeWorktree(
        db,
        parse(PROJECTION_SCHEMAS.worktree, {
          worktreeId,
          repo,
          branch,
          path,
          ownerPeerId,
          class: worktreeClass,
          dirty: false,
          unpushed: false,
          holders: [],
          createdAt: ts,
          updatedAt: ts,
        }),
      )
      return
    }
    case 'worktree.classified': {
      const { worktreeId, class: worktreeClass, dirty, unpushed, holders } = event.data
      const current = worktreeById(db, worktreeId)
      if (current === undefined) {
        missing(db, event, 'worktree', worktreeId)
        return
      }
      writeWorktree(
        db,
        parse(PROJECTION_SCHEMAS.worktree, {
          ...current,
          class: worktreeClass,
          dirty,
          unpushed,
          holders: holders as readonly Holder[],
          updatedAt: ts,
        }),
      )
      return
    }
    case 'worktree.removed': {
      // Removed from disk by `gc`: the row goes with it, and the event is the record.
      const { worktreeId } = event.data
      db.run('DELETE FROM worktree_holders WHERE worktree_id = ?', worktreeId)
      db.run('DELETE FROM worktrees WHERE worktree_id = ?', worktreeId)
      return
    }

    // ------------------------------------------------- decisions and signals
    case 'decision.requested': {
      const { decisionId, kind, question, options, workId, inputsHash, routedTo } = event.data
      writeDecision(
        db,
        parse(PROJECTION_SCHEMAS.decision, {
          decisionId,
          kind,
          state: 'open',
          question,
          options,
          inputsHash,
          workId,
          requestedAt: ts,
        }),
      )
      // A Judge answers its own questions; only a decision routed to the user is
      // a banner (§6.1 `needs your decision`).
      if (routedTo?.startsWith('judge') !== true) {
        raiseNotification(db, notificationKeyOf('decision', decisionId), 'decision', ts)
      }
      return
    }
    case 'decision.answered': {
      const { decisionId, source, option, text, judgeModel } = event.data
      const current = decisionById(db, decisionId)
      if (current !== undefined) {
        writeDecision(
          db,
          parse(PROJECTION_SCHEMAS.decision, {
            ...current,
            state: 'answered',
            option,
            text,
            source,
            judgeModel,
            answeredAt: ts,
          }),
        )
      }
      resolveNotification(db, notificationKeyOf('decision', decisionId), ts)
      return
    }
    case 'notify.sent': {
      const { key, class: notificationClass, channel, title, body } = event.data
      const current = notificationByKey(db, key)
      // A closed key stays closed: `fleet decide` answering first must not be
      // reopened by a banner that was already in flight (§6.1).
      if (current?.state === 'resolved') return
      writeNotification(
        db,
        parse(PROJECTION_SCHEMAS.notification, {
          key,
          class: notificationClass,
          state: 'sent',
          title,
          body,
          channel,
          deliveryFailed: false,
          occurrences: current?.occurrences ?? 1,
          createdAt: current?.createdAt ?? ts,
          sentAt: ts,
          // A second `notify.sent` for a key that was already sent is §6.1's quiet reminder, so this is where
          // `remindedAt` comes from: nothing else records that one was spent, and the rule allows only one.
          remindedAt: current?.state === 'sent' ? ts : current?.remindedAt,
          resolvedAt: current?.resolvedAt,
          withdrawnAt: current?.withdrawnAt,
        }),
      )
      return
    }
    case 'notify.failed': {
      const { key, class: notificationClass, channel } = event.data
      const current = notificationByKey(db, key)
      writeNotification(
        db,
        parse(PROJECTION_SCHEMAS.notification, {
          key,
          class: notificationClass,
          // Still pending: the decision stays visible in `fleet ls` and `fleet decide` (§6.1).
          state: current?.state ?? 'pending',
          title: current?.title,
          body: current?.body,
          channel,
          deliveryFailed: true,
          occurrences: current?.occurrences ?? 1,
          createdAt: current?.createdAt ?? ts,
          sentAt: current?.sentAt,
          remindedAt: current?.remindedAt,
          resolvedAt: current?.resolvedAt,
          withdrawnAt: current?.withdrawnAt,
        }),
      )
      return
    }
    case 'notify.withdrawn': {
      const current = notificationByKey(db, event.data.key)
      // The one field that makes the withdraw idempotent: a key already withdrawn — or never delivered, so with no
      // banner to clear — is left alone, and the planner can ask "was this closed *and* cleared?" from the row (§6.1).
      if (current === undefined || current.withdrawnAt !== undefined) {
        resolveNotification(db, event.data.key, ts)
        return
      }
      writeNotification(
        db,
        parse(PROJECTION_SCHEMAS.notification, { ...current, state: 'resolved', resolvedAt: current.resolvedAt ?? ts, withdrawnAt: ts }),
      )
      return
    }
    case 'standup.rendered': {
      const { date } = event.data
      const key = notificationKeyOf('standup', date)
      const current = notificationByKey(db, key)
      if (current === undefined) {
        writeNotification(
          db,
          parse(PROJECTION_SCHEMAS.notification, {
            key,
            class: 'standup',
            state: 'pending',
            deliveryFailed: false,
            occurrences: 1,
            createdAt: ts,
          }),
        )
      }
      return
    }
    case 'finding.raised': {
      const { findingId, fingerprint, tool, ruleId, severity, path, line, message, sha } = event.data
      // A fingerprint already on file is the same finding seen again (§6.2).
      const known = findingByFingerprint(db, fingerprint)
      writeFinding(
        db,
        parse(PROJECTION_SCHEMAS.finding, {
          ...(known ?? {}),
          findingId,
          fingerprint,
          tool,
          ruleId,
          severity,
          path,
          line,
          message,
          sha,
          state: known?.state ?? 'open',
          seenCount: (known?.seenCount ?? 0) + 1,
          raisedAt: known?.raisedAt ?? ts,
        }),
      )
      return
    }
    case 'finding.seen': {
      const { findingId, sha } = event.data
      const current = findingById(db, findingId)
      if (current === undefined) {
        missing(db, event, 'finding', findingId)
        return
      }
      writeFinding(db, parse(PROJECTION_SCHEMAS.finding, { ...current, sha, seenCount: current.seenCount + 1 }))
      return
    }
    case 'finding.verdict_given': {
      const { findingId, verdict, reason, by } = event.data
      const current = findingById(db, findingId)
      if (current === undefined) {
        missing(db, event, 'finding', findingId)
        return
      }
      writeFinding(
        db,
        parse(PROJECTION_SCHEMAS.finding, {
          ...current,
          state: verdict,
          reason,
          verifiedBy: by,
          verifiedAt: ts,
        }),
      )
      return
    }
    case 'finding.routed': {
      const { findingId, workId, decisionId } = event.data
      const current = findingById(db, findingId)
      if (current === undefined) {
        missing(db, event, 'finding', findingId)
        return
      }
      writeFinding(db, parse(PROJECTION_SCHEMAS.finding, { ...current, workId, decisionId }))
      return
    }
    case 'turn.usage_recorded': {
      const { peerId, workId, inputTokens, outputTokens, cachedTokens, toolCalls, costUsd } = event.data
      // The boundary is the only place a turn's end is recorded, so it is also
      // where "when did this peer last finish a turn" is kept for `fleet ls`.
      db.run(
        `INSERT INTO peer_activity (peer_id, last_turn_at) VALUES (?, ?)
         ON CONFLICT (peer_id) DO UPDATE SET last_turn_at = excluded.last_turn_at`,
        peerId,
        ts,
      )
      const role = peerById(db, peerId)?.role ?? 'unknown'
      // The per-Work row, and the peer's rollup under the empty work id (§6.2).
      const rows: readonly string[] = workId === undefined ? [''] : [workId, '']
      for (const key of rows) {
        const current = tokenReportFor(db, peerId, role, key)
        writeTokenReport(
          db,
          parse(PROJECTION_SCHEMAS.tokenReport, {
            peerId,
            role,
            workId: key === '' ? undefined : key,
            turns: current.turns + 1,
            inputTokens: current.inputTokens + inputTokens,
            outputTokens: current.outputTokens + outputTokens,
            cachedTokens: current.cachedTokens + cachedTokens,
            // A turn that reported no price adds nothing: the rollup stays the
            // sum of what was actually priced (§6.2).
            costUsd: current.costUsd + (costUsd ?? 0),
            toolCalls: {
              grep: current.toolCalls.grep + toolCalls.grep,
              glob: current.toolCalls.glob + toolCalls.glob,
              read: current.toolCalls.read + toolCalls.read,
              codegraph: current.toolCalls.codegraph + toolCalls.codegraph,
            },
            redirects: current.redirects,
            updatedAt: ts,
          }),
        )
      }
      return
    }

    // ------------------------------------------------------------------ evals
    case 'eval.run_started': {
      const { runId, suite, sha, provider, model, cases } = event.data
      const current = evalRunById(db, runId)
      if (current !== undefined) {
        // A start is identity, not a reset: the row it finds — running or finished — keeps its
        // state, its aggregates and its denominator, so a replayed append, or a runner that
        // resumed with the runId it already used, cannot put a finished run back to running or
        // shrink the `cases` its `passed` was measured against.
        if (
          current.suite !== suite ||
          current.sha !== sha ||
          current.provider !== provider ||
          current.model !== model ||
          current.cases !== cases
        ) {
          // Not an idempotent repeat but a different run wearing the same id, which would
          // otherwise rewrite a scored run's identity silently. The log keeps the event; the
          // row keeps what it measured; the disagreement is why anomalies exist (§3).
          recordAnomaly(db, event, 'evalRun', `run ${runId} was already opened as ${current.suite}@${current.sha}`)
        }
        return
      }
      writeEvalRun(
        db,
        parse(PROJECTION_SCHEMAS.evalRun, {
          runId,
          suite,
          sha,
          provider,
          model,
          cases,
          state: 'running',
          startedAt: ts,
        }),
      )
      return
    }
    case 'eval.case_scored': {
      const { runId, caseId, attempt, pass, score, detail } = event.data
      // A case belongs to a run, and only the two run events carry the run's identity, so a
      // `case_scored` for a run the log never opened cannot be projected (§3).
      if (evalRunById(db, runId) === undefined) {
        missing(db, event, 'evalRun', runId)
        return
      }
      const current = evalCaseFor(db, runId, caseId)
      const attempts = current?.attempts ?? 0
      // Attempt numbers are the adapter's, so the same one can arrive twice (an append
      // retried after a lost reply) and a slower attempt can land after a faster later one.
      // Only a number above every one already tallied is a new attempt: that is the attempt
      // the row's verdict belongs to, and the only one that can count a pass. Counting any
      // arrival would let `passes` outrun `attempts` — a pass rate no run produced, over a
      // number §17 gates on.
      if (attempt <= attempts) {
        // Not a silent no-op: a repeat is expected, but an attempt numbered below one already
        // tallied is the adapter disagreeing with itself, and the tally it disagrees with is
        // what a baseline is compared against. The anomaly is keyed by event seq, so a replay
        // records exactly the same row.
        recordAnomaly(db, event, 'evalCase', `attempt ${attempt} of ${caseId} is not above the ${attempts} tallied`)
        return
      }
      writeEvalCase(
        db,
        parse(PROJECTION_SCHEMAS.evalCase, {
          runId,
          caseId,
          attempts: attempt,
          passes: (current?.passes ?? 0) + (pass ? 1 : 0),
          pass,
          score,
          detail,
          updatedAt: ts,
        }),
      )
      return
    }
    case 'eval.run_finished': {
      const { runId, suite, sha, provider, model, cases, passed, tokensIn, tokensOut, costUsd, latencyMs } = event.data
      const current = evalRunById(db, runId)
      writeEvalRun(
        db,
        parse(PROJECTION_SCHEMAS.evalRun, {
          // §17's first slice records a finished run without a start, and this event carries the
          // whole identity, so it opens the row when there is none to close.
          ...current,
          runId,
          suite,
          sha,
          provider,
          model,
          cases,
          state: 'finished',
          passed,
          tokensIn,
          tokensOut,
          costUsd,
          latencyMs,
          startedAt: current?.startedAt ?? ts,
          finishedAt: ts,
        }),
      )
      // A finished run whose pass count fell under the committed baseline is what the standup
      // shows next to `<passed>/<cases>`; turning that into a notification is the routine's
      // rule (§6.1, §17), not the store's.
      return
    }

    case 'judge.requested': {
      const { questionId, kind, inputsHash, workId, askedFor } = event.data
      // The `input` the question was formed from is deliberately not kept: it is
      // the card's own text, already in the `work` row, and storing it again would
      // make every answer's row carry a copy of the fleet's longest fields. The
      // hash is what §5.4 needs a replay to recognise.
      writeJudgeQuestion(
        db,
        parse(PROJECTION_SCHEMAS.judgeQuestion, {
          questionId,
          kind,
          inputsHash,
          workId,
          askedFor,
          askedAt: ts,
        }),
      )
      return
    }
    case 'judge.answered': {
      const { questionId, answer, model } = event.data
      const current = judgeQuestionById(db, questionId)
      // An answer with no question is a log that lost its head: `missing` records
      // the anomaly rather than inventing a question to hang the answer on.
      if (current === undefined) {
        missing(db, event, 'judge', questionId)
        return
      }
      writeJudgeQuestion(db, parse(PROJECTION_SCHEMAS.judgeQuestion, { ...current, answer, model, answeredAt: ts }))
      return
    }
    // ---------------------------------------------- recorded, not projected yet
    // `purge.*`, `index.*` and `scan.skipped` describe a process, not a row the
    // PM or the board reads. They stay in `events` and are read from there.
    //
    // Named one by one, never caught by a `default`: a new type in the registry
    // then has to be *decided* here — projected above, or recorded-only in this
    // list — because the `satisfies` below makes forgetting it a typecheck error.
    case 'purge.started':
    case 'purge.saved':
    case 'purge.degraded':
    case 'purge.completed':
    case 'index.ready':
    case 'index.failed':
    case 'scan.skipped':
    // `tracker.synced` is the board's answer to one sync (§3). Nothing in the
    // fleet is derived from it — the Work rows come from `work.*` — so it is an
    // audit trail, read from `events` when someone asks what the board said.
    case 'tracker.synced':
    // `branch.deleted` is the record a deleted branch can be restored from (§10):
    // `sha` is the commit it pointed at. No row is derived from it — the PR row it
    // came from is already merged — so it is read from `events` when someone asks
    // where a branch went.
    case 'branch.deleted':
      return
  }

  // TypeScript narrows `event` to `never` here only when every type in the registry is
  // handled above, so this line is the exhaustiveness check: a new event type fails it
  // rather than silently projecting nothing.
  const unprojected: never = event
  return unprojected
}

// ------------------------------------------------------------------------ evals

const EVAL_RUN_COLUMNS = [
  'run_id',
  'suite',
  'sha',
  'provider',
  'model',
  'state',
  'cases',
  'passed',
  'tokens_in',
  'tokens_out',
  'cost_usd',
  'latency_ms',
  'started_at',
  'finished_at',
  'data',
] as const

const EVAL_CASE_COLUMNS = ['run_id', 'case_id', 'attempts', 'passes', 'pass', 'score', 'detail', 'updated_at', 'data'] as const

/** A null column means the field is absent: `costUsd` is "not reported", never `0` (§17). */
const orNull = (value: number | undefined): number | null => value ?? null

const writeEvalRun = (db: Sqlite, run: EvalRun): void => {
  writeRow(
    db,
    'eval_runs',
    EVAL_RUN_COLUMNS,
    [
      run.runId,
      run.suite,
      run.sha,
      run.provider,
      run.model,
      run.state,
      run.cases,
      orNull(run.passed),
      orNull(run.tokensIn),
      orNull(run.tokensOut),
      orNull(run.costUsd),
      orNull(run.latencyMs),
      run.startedAt,
      run.finishedAt ?? null,
      JSON.stringify(run),
    ],
    ['run_id'],
  )
}

const writeEvalCase = (db: Sqlite, row: EvalCase): void => {
  writeRow(
    db,
    'eval_cases',
    EVAL_CASE_COLUMNS,
    [
      row.runId,
      row.caseId,
      row.attempts,
      row.passes,
      row.pass ? 1 : 0,
      row.score,
      row.detail,
      row.updatedAt,
      JSON.stringify(row),
    ],
    ['run_id', 'case_id'],
  )
}

const evalRunById = (db: Sqlite, runId: string): EvalRun | undefined => {
  const row = db.get<{ data: string }>('SELECT data FROM eval_runs WHERE run_id = ?', runId)
  return row === undefined ? undefined : json(PROJECTION_SCHEMAS.evalRun, row.data)
}

const evalCaseFor = (db: Sqlite, runId: string, caseId: string): EvalCase | undefined => {
  const row = db.get<{ data: string }>('SELECT data FROM eval_cases WHERE run_id = ? AND case_id = ?', runId, caseId)
  return row === undefined ? undefined : json(PROJECTION_SCHEMAS.evalCase, row.data)
}

// ------------------------------------------------------------------- the reader

/**
 * The read side of the store (§3): the projections as typed arrays, the same
 * shape `Mailbox` and the routines were written against. Ordered by a natural
 * key so `fleet ls` and the standup are stable between runs.
 */
export const readers = (db: Sqlite): ReadModel => {
  const rows = <T>(schema: Schema<T>, sql: string, ...params: readonly string[]): readonly T[] =>
    db.all<{ data: string }>(sql, ...params).map((row) => json(schema, row.data))

  return {
    peers: {
      all: async () => db.all<PeerRow>('SELECT * FROM peers ORDER BY peer_id').map((row) => peerFromRow(row)),
      get: async (id) => peerById(db, id),
    },
    sessions: {
      all: async () =>
        rows(PROJECTION_SCHEMAS.session, 'SELECT data FROM sessions ORDER BY started_at, session_id'),
      forPeer: async (id) =>
        rows(PROJECTION_SCHEMAS.session, 'SELECT data FROM sessions WHERE peer_id = ? ORDER BY started_at', id),
    },
    work: {
      all: async () => rows(PROJECTION_SCHEMAS.work, 'SELECT data FROM work ORDER BY created_at, work_id'),
      get: async (id) => workById(db, id),
    },
    decisions: {
      all: async () => rows(PROJECTION_SCHEMAS.decision, 'SELECT data FROM decisions ORDER BY requested_at, decision_id'),
      open: async () =>
        rows(PROJECTION_SCHEMAS.decision, "SELECT data FROM decisions WHERE state = 'open' ORDER BY requested_at"),
      get: async (id) => decisionById(db, id),
    },
    notifications: {
      all: async () => rows(PROJECTION_SCHEMAS.notification, 'SELECT data FROM notifications ORDER BY created_at, key'),
      get: async (key) => notificationByKey(db, key),
    },
    judge: {
      all: async () =>
        rows(PROJECTION_SCHEMAS.judgeQuestion, 'SELECT data FROM judge_questions ORDER BY asked_at, question_id'),
      get: async (id) => judgeQuestionById(db, id),
    },
    findings: {
      all: async () => rows(PROJECTION_SCHEMAS.finding, 'SELECT data FROM findings ORDER BY raised_at, finding_id'),
    },
    messages: {
      all: async () => db.all<MessageRow>('SELECT * FROM messages ORDER BY sent_at, msg_id').map((row) => messageFromRow(row)),
      forPeer: async (id) =>
        db
          .all<MessageRow>('SELECT * FROM messages WHERE to_peer = ? ORDER BY sent_at, msg_id', id)
          .map((row) => messageFromRow(row)),
    },
    pullRequests: {
      all: async () =>
        rows(
          PROJECTION_SCHEMAS.pullRequest,
          'SELECT data FROM pull_requests ORDER BY repo, number',
        ),
    },
    worktrees: {
      all: async () => rows(PROJECTION_SCHEMAS.worktree, 'SELECT data FROM worktrees ORDER BY path'),
    },
    builds: {
      find: async (repo, sha, task) => buildByKey(db, repo, sha, task),
      get: async (id) => buildById(db, id),
    },
    routines: {
      all: async () => db.all<RoutineRow>('SELECT * FROM routines ORDER BY routine_id').map((row) => routineFromRow(row)),
    },
    evals: {
      get: async (runId) => {
        const run = evalRunById(db, runId)
        if (run === undefined) return undefined
        const cases = rows<EvalCase>(PROJECTION_SCHEMAS.evalCase, 'SELECT data FROM eval_cases WHERE run_id = ? ORDER BY case_id', runId)
        return { run, cases }
      },
    },
    tokens: {
      // Every row, the peer rollup (`work_id = ''`) first: §6.2's report is read
      // whole — `fleet ls` prints both levels and the board looks a Work up — and
      // the table is one row per peer per Work, not one per turn, so there is
      // nothing here that grows with the log's history.
      all: async () =>
        db.all<TokenRow>('SELECT * FROM token_report ORDER BY peer_id, work_id').map((row) => tokenReportFromRow(row)),
    },
    activity: {
      // One query for the whole fleet: the last tool, the current Work, and that
      // Work's edit count, joined in SQL. A peer with neither an activity row nor
      // a current Work is not returned — the caller has no use for a row that says
      // nothing, the same reason compactions return only peers that compacted.
      all: async () =>
        db
          .all<{
            peer_id: string
            work_id: string | null
            last_tool: string | null
            last_target: string | null
            last_tool_at: string | null
            last_turn_at: string | null
            edits: number
          }>(
            `SELECT p.peer_id,
                    w.work_id,
                    a.last_tool,
                    a.last_target,
                    a.last_tool_at,
                    a.last_turn_at,
                    (SELECT COALESCE(SUM(c.count), 0) FROM peer_tool_counts c
                      WHERE c.peer_id = p.peer_id AND c.work_id = w.work_id) AS edits
               FROM peers p
               LEFT JOIN peer_activity a ON a.peer_id = p.peer_id
               LEFT JOIN work w ON w.work_id = (
                 SELECT w2.work_id FROM work w2
                  WHERE w2.assignee = p.peer_id AND w2.state NOT IN ('cleaned', 'cancelled')
                  ORDER BY w2.updated_at DESC, w2.work_id
                  LIMIT 1)
              WHERE a.peer_id IS NOT NULL OR w.work_id IS NOT NULL
              ORDER BY p.peer_id`,
          )
          .map((row) =>
            parse(PROJECTION_SCHEMAS.peerActivity, {
              peerId: row.peer_id,
              ...(row.work_id === null ? {} : { workId: row.work_id }),
              ...(row.last_tool === null ? {} : { lastTool: row.last_tool }),
              ...(row.last_target === null ? {} : { lastTarget: row.last_target }),
              ...(row.last_tool_at === null ? {} : { lastToolAt: row.last_tool_at }),
              ...(row.last_turn_at === null ? {} : { lastTurnAt: row.last_turn_at }),
              edits: row.edits,
            }),
          ),
    },
    compactions: {
      // Grouped in SQL rather than by the caller: `fleet ls` wants a count per
      // peer and a fleet-wide total, and the log holds every compaction, not
      // just the latest (§8).
      all: async () =>
        db
          .all<{
            peer_id: string
            count: number
            last_at: string
            last_trigger: string
            last_pre_tokens: number
          }>(
            `SELECT peer_id,
                    COUNT(*)                                       AS count,
                    MAX(ts)                                        AS last_at,
                    (SELECT last_q.trigger FROM peer_compactions last_q
                      WHERE last_q.peer_id = grouped.peer_id
                      ORDER BY last_q.ts DESC, last_q.seq DESC LIMIT 1)    AS last_trigger,
                    (SELECT last_q.pre_tokens FROM peer_compactions last_q
                      WHERE last_q.peer_id = grouped.peer_id
                      ORDER BY last_q.ts DESC, last_q.seq DESC LIMIT 1)    AS last_pre_tokens
               FROM peer_compactions grouped
              GROUP BY peer_id
              ORDER BY peer_id`,
          )
          .map((row) =>
            parse(PROJECTION_SCHEMAS.peerCompactions, {
              peerId: row.peer_id,
              count: Number(row.count),
              lastAt: row.last_at,
              lastTrigger: row.last_trigger,
              lastPreTokens: Number(row.last_pre_tokens),
            }),
          ),
    },
  }
}
