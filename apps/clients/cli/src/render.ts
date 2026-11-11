/**
 * What the CLI prints, as pure functions from a daemon answer to text.
 *
 * Separated from `run.ts` so the layout is a test with no socket in it, and
 * kept deliberately plain: aligned columns, one row per projection row, no
 * colour and no boxes. A peer reading this in a transcript, a person reading
 * it in a terminal and a test asserting on it all get the same characters.
 *
 * Nothing here decides anything. If a row has a state, the state is printed as
 * the projection spells it (`waiting_input`, `open`), not translated into
 * prose: two vocabularies for one field is how a client drifts from the store.
 */

import type {
  BuildsResult,
  Decision,
  FleetEvent,
  Message,
  Peer,
  PeerActivity,
  PeerCompactions,
  ReplayResult,
  Routine,
  TokenReport,
} from '@fleet/foundation-contracts'
import type { DownResult, LsResult, NoteResult, PeekResult, SendResult, UpResult } from '@fleet/foundation-contracts'

const indent = (lines: readonly string[], by: number): readonly string[] =>
  lines.map((line) => `${' '.repeat(by)}${line}`)

/** Rows as aligned columns; the last column is never padded, so no line ends in spaces. */
const columns = (rows: readonly (readonly string[])[]): readonly string[] => {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}

const section = (title: string, count: number, rows: readonly string[], empty: string): readonly string[] => [
  `${title} (${String(count)})`,
  ...indent(rows.length === 0 ? [empty] : rows, 2),
]

const peerRow = (peer: Peer): readonly string[] => [
  peer.peerId,
  peer.role,
  `${peer.providerId}/${peer.model}`,
  peer.state,
  `brief v${String(peer.briefVersion)}`,
  peer.currentSessionId ?? '-',
]

/**
 * What a busy peer is doing (§4). `state` says `working`; this says at what, on
 * which Work, and how much of that Work it has rewritten — the three things a
 * person watching a fleet wants before deciding whether to interrupt it.
 *
 * The target is the provider's own short summary (a path, a description), so it
 * is already safe to print. It is shortened again here only so one long path
 * cannot push the other columns off a terminal; the daemon's payload is not cut.
 */
const activityRow = (row: PeerActivity): readonly string[] => [
  row.peerId,
  row.lastTool ?? '-',
  row.lastTarget === undefined ? '-' : shorten(row.lastTarget, 56),
  row.workId ?? '-',
  `edits ${String(row.edits)}`,
  row.lastTurnAt ?? 'no turn yet',
  // From the last recorded turn; a peer with none shows no number, never 0%.
  row.contextTokens === undefined || row.contextLimit === undefined
    ? 'ctx -'
    : `ctx ${String(Math.round((row.contextTokens / row.contextLimit) * 100))}%`,
]

const shorten = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`

const routineRow = (routine: Routine): readonly string[] => [
  routine.kind,
  routine.state,
  `runs ${String(routine.runs)}`,
  `failures ${String(routine.failures)}`,
  routine.lastRunAt ?? 'never',
  routine.routineId,
]

/**
 * A compaction is the one row in `fleet ls` that is a warning rather than a
 * status: it means a peer's context was rewritten and its bill grew (§8). The
 * last trigger and the tokens it compacted are on the row so the reader can
 * tell a person's `/compact` from the provider doing it on its own.
 */
const compactionRow = (row: PeerCompactions): readonly string[] => [
  row.peerId,
  `${String(row.count)}x`,
  `last ${row.lastTrigger}`,
  `pre ${String(row.lastPreTokens)}`,
  row.lastAt,
]

/**
 * §6.2's cost report, one line per row: a peer's rollup (`all`) and its rows per
 * Work. Tokens stay counts — the report measures them — and the cost is the sum
 * of the turns that published a price, so a provider that prices nothing shows
 * `$0.00` rather than a guess.
 */
const tokenRow = (row: TokenReport): readonly string[] => [
  row.peerId,
  row.role,
  row.workId ?? 'all',
  `${String(row.turns)} turns`,
  `in ${String(row.inputTokens)}`,
  `out ${String(row.outputTokens)}`,
  `cached ${String(row.cachedTokens)}`,
  `$${row.costUsd.toFixed(2)}`,
]

/**
 * A decision is three lines: the row, the closed set the answer must come
 * from, and the command that answers it — so `fleet ls` is enough to act on
 * without going back to the docs (§6.1).
 */
const decisionLines = (row: Decision): readonly string[] => {
  const head = [row.decisionId, row.kind, row.state, row.question].join('  ')
  const answer = row.option ?? row.text
  const lines = [head]
  if (answer !== undefined) lines.push(`answered: ${answer}`)
  if (row.options.length > 0) lines.push(`options: ${row.options.join(' | ')}`)
  if (row.state === 'open') lines.push(`answer: fleet decide ${row.decisionId} <option>`)
  return lines
}

export const formatLs = (result: LsResult): string => {
  const { status } = result
  // Decisions are variable-length, so they are not columnised: aligning the
  // first cell of a block whose other lines have no columns would line up the
  // ids and nothing else. A blank line between them is what separates them.
  const decisionRows = result.decisions.flatMap((row, index) =>
    index === 0 ? decisionLines(row) : ['', ...decisionLines(row)],
  )
  const total = result.compactions.reduce((sum, row) => sum + row.count, 0)
  // The rollup rows are the fleet's bill; the per-Work rows are its breakdown and
  // summing those too would count every turn twice.
  const spend = result.tokens
    .filter((row) => row.workId === undefined)
    .reduce((sum, row) => sum + row.costUsd, 0)
  const lines = [
    `${status.profile}  pid ${String(status.pid)}  up since ${status.startedAt}`,
    `socket  ${status.socketPath}`,
    `store   ${status.storePath}`,
    '',
    ...section('peers', result.peers.length, columns(result.peers.map(peerRow)), 'none registered'),
    '',
    // Right after the peers, because it answers the question the peers row raises:
    // a peer that says `working` is a peer whose reader wants to know at what (§4).
    ...section(
      'activity',
      result.activity.length,
      columns(result.activity.map(activityRow)),
      'none: no peer has a Work or has used a tool',
    ),
    '',
    ...section('routines', result.routines.length, columns(result.routines.map(routineRow)), 'none'),
    '',
    ...section(
      // The count is in the heading, not only on the rows: a fleet whose peers
      // are all quietly compacting should say so in one number (§8).
      `compactions (${String(total)} total)`,
      result.compactions.length,
      columns(result.compactions.map(compactionRow)),
      'none: no peer has compacted',
    ),
    '',
    ...section(`tokens ($${spend.toFixed(2)} total)`, result.tokens.length, columns(result.tokens.map(tokenRow)), 'none: no turn has been recorded'),
    '',
    ...section('decisions', result.decisions.length, decisionRows, 'nothing waiting on the user'),
  ]
  return lines.join('\n')
}

export const formatUp = (result: UpResult): string => {
  const lines = [
    `${result.profile} up, pid ${String(result.pid)}`,
    `socket  ${result.socketPath}`,
    `store   ${result.storePath}`,
  ]
  // The fleet is up; these are the things it started *despite* (TASK-12), so they
  // come after the addresses and are prefixed rather than reworded as a failure.
  for (const warning of result.warnings ?? []) lines.push(`warn    ${warning}`)
  return lines.join('\n')
}

export const formatDown = (_result: DownResult): string => 'fleetd stopped'

export const formatSend = (result: SendResult, peer: string): string => `sent ${result.msgId} to ${peer}`

/** `fleet note` echoes the Work: the peer named the phase, the daemon named the Work it landed on. */
export const formatNote = (result: NoteResult): string =>
  `noted ${result.phase} on ${String(result.workId)} (mirrored to the board when the profile maps one)`

const messageLines = (message: Message): readonly string[] => {
  const head = [
    message.msgId,
    `${message.from} -> ${message.to}`,
    message.kind,
    message.state,
    `brief v${String(message.briefVersion)}`,
    message.sentAt,
  ].join('  ')
  return [head, ...indent([message.body], 4)]
}

export const formatPeek = (result: PeekResult, peer: string): string => {
  if (result.messages.length === 0) return `${peer}: no messages`
  const lines = [`${peer}: ${String(result.messages.length)} message(s)`]
  for (const message of result.messages) lines.push('', ...indent(messageLines(message), 2))
  return lines.join('\n')
}

export const formatDecision = (row: Decision): string => decisionLines(row).join('\n')

/** One log line, in the envelope's own order: where, when, what, about whom. */
const eventRow = (event: FleetEvent): readonly string[] => [String(event.seq), event.ts, event.type, event.subject]

/**
 * A rebuild is one sentence, because there is one thing to say: the log is
 * where it was and every projection was derived from it again. A window is the
 * events, one per line, oldest first — the reader asked for the log and the log
 * is what they get, not a summary of it.
 */
export const formatReplay = (result: ReplayResult): string => {
  if (result.mode === 'rebuild') {
    return `rebuilt every projection from ${String(result.events)} event(s); the log is at seq ${String(result.latestSeq)}`
  }
  if (result.events.length === 0) return 'no events in that window'
  return [`${String(result.events.length)} event(s)`, ...indent(columns(result.events.map(eventRow)), 2)].join('\n')
}

/**
 * A build is reported as the ledger recorded it, dedupe and all (§11).
 *
 * `deduped` is printed rather than inferred from the status, because it is the
 * one thing the caller cannot see in the row: the same row comes back whether
 * this request ran the command or a previous one already had, and that
 * difference is the whole point of the key.
 */
export const formatBuild = (result: BuildsResult): string => {
  const { build } = result
  const lines = [
    `${build.buildId}  ${build.status}  ${build.repo}@${build.sha}`,
    `task  ${build.task}`,
    `host  ${build.host}`,
  ]
  if (build.durationMs !== undefined) lines.push(`took  ${String(build.durationMs)}ms`)
  if (build.logPath !== undefined) lines.push(`log   ${build.logPath}`)
  lines.push(result.deduped ? 'reused: this triple had already run, so nothing ran again' : 'ran: no previous build of this triple')
  return lines.join('\n')
}
