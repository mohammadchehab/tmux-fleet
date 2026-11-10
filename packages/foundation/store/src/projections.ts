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
  type Finding,
  type FleetEvent,
  type Holder,
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
  'token_report',
  'messages',
] as const

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
const updatePeer = (db: Sqlite, peerId: string, patch: Partial<Peer>, ts: string): Peer | undefined => {
  const current = peerById(db, peerId)
  if (current === undefined) return undefined
  const next = parse(PROJECTION_SCHEMAS.peer, { ...current, ...patch, updatedAt: ts })
  writePeer(db, next)
  return next
}

// --------------------------------------------------------------------- sessions

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
      work.workId,
      work.title,
      work.state,
      work.role ?? null,
      work.assignee ?? null,
      work.contractId ?? null,
      work.briefId ?? null,
      work.briefVersion ?? null,
      work.createdAt,
      work.updatedAt,
      JSON.stringify(work),
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

const updateWork = (db: Sqlite, workId: string, patch: Partial<Work>, ts: string): void => {
  const current = workById(db, workId)
  if (current === undefined) return
  writeWork(db, parse(PROJECTION_SCHEMAS.work, { ...current, ...patch, updatedAt: ts }))
}

/** Add a PR to a Work without duplicating one already recorded. */
const withPr = (current: Work, pr: PullRequestRef): Work['prs'] =>
  current.prs.some((known) => known.repo === pr.repo && known.number === pr.number)
    ? current.prs
    : [...current.prs, { repo: pr.repo, number: pr.number }]

const attachPr = (db: Sqlite, workId: string, pr: PullRequestRef, ts: string): void => {
  const current = workById(db, workId)
  if (current === undefined) return
  updateWork(db, workId, { prs: withPr(current, pr) }, ts)
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
  ts: string,
): void => {
  const current = pullRequestById(db, repo, number)
  if (current === undefined) return
  writePullRequest(db, parse(PROJECTION_SCHEMAS.pullRequest, { ...current, ...patch, updatedAt: ts }))
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
    ackedAt: row.acked_at ?? undefined,
    currentBriefVersion: row.current_brief_version ?? undefined,
  })

export const messageById = (db: Sqlite, msgId: string): Message | undefined => {
  const row = db.get<MessageRow>('SELECT * FROM messages WHERE msg_id = ?', msgId)
  return row === undefined ? undefined : messageFromRow(row)
}

const updateMessage = (db: Sqlite, msgId: string, patch: Partial<Message>): void => {
  const current = messageById(db, msgId)
  if (current === undefined) return
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

const updateRoutine = (db: Sqlite, routineId: string, patch: Partial<Routine>): void => {
  const current = routineById(db, routineId)
  if (current === undefined) return
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

const resolveNotification = (db: Sqlite, key: NotificationKey, ts: string): void => {
  const current = notificationByKey(db, key)
  if (current === undefined || current.state === 'resolved') return
  writeNotification(db, parse(PROJECTION_SCHEMAS.notification, { ...current, state: 'resolved', resolvedAt: ts }))
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
    case 'peer.state_changed': {
      const { peerId, state, sessionId } = event.data
      updatePeer(db, peerId, sessionId === undefined ? { state } : { state, currentSessionId: sessionId }, ts)
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
        ts,
      )
      // §6.1 `failure`: a crash, a session that will not resume, a config mismatch.
      raiseNotification(db, notificationKeyOf('failure', peerId, reason), 'failure', ts)
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
      updatePeer(db, peerId, { currentSessionId: sessionId }, ts)
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
      if (peer?.currentSessionId === sessionId) updatePeer(db, peerId, { currentSessionId: undefined }, ts)
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
      updateWork(db, event.data.workId, { state: 'needs_contract', contractId: event.data.contractId }, ts)
      return
    case 'work.ready':
      updateWork(db, event.data.workId, { state: 'ready' }, ts)
      return
    case 'work.assigned': {
      const { workId, peerId, briefId, briefVersion } = event.data
      updateWork(db, workId, { state: 'assigned', assignee: peerId, briefId, briefVersion }, ts)
      return
    }
    case 'work.started':
      updateWork(db, event.data.workId, { state: 'in_progress', assignee: event.data.peerId }, ts)
      return
    case 'work.review_requested': {
      const { workId, pr } = event.data
      const current = workById(db, workId)
      if (current === undefined) return
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
      if (current === undefined) return
      writeWork(
        db,
        parse(PROJECTION_SCHEMAS.work, { ...current, state, prs: withPr(current, pr), updatedAt: ts }),
      )
      return
    }
    case 'work.cleaned':
      updateWork(db, event.data.workId, { state: 'cleaned' }, ts)
      return
    case 'work.blocked':
      updateWork(db, event.data.workId, { state: 'blocked', blockedReason: event.data.reason }, ts)
      return
    case 'work.cancelled':
      updateWork(db, event.data.workId, { state: 'cancelled', blockedReason: event.data.reason }, ts)
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
      updatePeer(db, peerId, { briefVersion: version }, ts)
      // And the Work's current brief moves with it, so the `stale` rule (§5.2) compares against the brief
      // actually published, not the one `work.assigned` first named. A no-op for a Work that does not exist.
      updateWork(db, workId, { briefId, briefVersion: version }, ts)
      return
    }
    case 'brief.superseded': {
      const { briefId, supersededBy } = event.data
      const current = briefById(db, briefId)
      if (current === undefined) return
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
      if (workId !== undefined) attachPr(db, workId, pr, ts)
      return
    }
    case 'pr.checks_changed': {
      const { pr, headSha, state, failing } = event.data
      updatePullRequest(db, pr.repo, pr.number, { headSha, checks: state, failingChecks: failing }, ts)
      return
    }
    case 'pr.review_changed': {
      const { pr, headSha, state } = event.data
      updatePullRequest(db, pr.repo, pr.number, { headSha, review: state }, ts)
      return
    }
    case 'pr.merged': {
      const { pr, headSha } = event.data
      updatePullRequest(db, pr.repo, pr.number, { headSha, merged: true }, ts)
      return
    }
    case 'pr.retargeted': {
      const { pr, toBase } = event.data
      updatePullRequest(db, pr.repo, pr.number, { base: toBase }, ts)
      return
    }
    case 'ci.failed_final': {
      const { pr, headSha, check } = event.data
      const current = pullRequestById(db, pr.repo, pr.number)
      const failing = current?.failingChecks.includes(check) === true ? current.failingChecks : [...(current?.failingChecks ?? []), check]
      updatePullRequest(db, pr.repo, pr.number, { headSha, checks: 'failing', failingChecks: failing }, ts)
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
      if (current === undefined) return
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
          message.body,
        ],
        ['msg_id'],
      )
      return
    }
    case 'message.delivered':
      updateMessage(db, event.data.msgId, { state: 'delivered', deliveredAt: ts })
      return
    case 'message.acked':
      updateMessage(db, event.data.msgId, { state: 'acked', ackedAt: ts })
      return
    case 'message.rejected':
      updateMessage(db, event.data.msgId, {
        state: 'rejected',
        currentBriefVersion: event.data.currentBriefVersion,
      })
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
      updateRoutine(db, event.data.routineId, { state: 'finished', lastRunAt: ts })
      return
    case 'routine.failed': {
      const routineId = event.data.routineId
      const current = routineById(db, routineId)
      updateRoutine(db, routineId, {
        state: 'failed',
        lastRunAt: ts,
        failures: (current?.failures ?? 0) + 1,
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
      if (current === undefined) return
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
          remindedAt: current?.remindedAt,
          resolvedAt: current?.resolvedAt,
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
        }),
      )
      return
    }
    case 'notify.withdrawn': {
      resolveNotification(db, event.data.key, ts)
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
      if (current === undefined) return
      writeFinding(db, parse(PROJECTION_SCHEMAS.finding, { ...current, sha, seenCount: current.seenCount + 1 }))
      return
    }
    case 'finding.verdict_given': {
      const { findingId, verdict, reason, by } = event.data
      const current = findingById(db, findingId)
      if (current === undefined) return
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
      if (current === undefined) return
      writeFinding(db, parse(PROJECTION_SCHEMAS.finding, { ...current, workId, decisionId }))
      return
    }
    case 'turn.usage_recorded': {
      const { peerId, workId, inputTokens, outputTokens, cachedTokens, toolCalls } = event.data
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

    // ---------------------------------------------- recorded, not projected yet
    // `judge.requested`/`judge.answered` are the typed question log (§5.3);
    // `purge.*`, `index.*` and `scan.skipped` describe a process, not a row the
    // PM or the board reads. They stay in `events` and are read from there.
    default:
      return
  }
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
    routines: {
      all: async () => db.all<RoutineRow>('SELECT * FROM routines ORDER BY routine_id').map((row) => routineFromRow(row)),
    },
  }
}
