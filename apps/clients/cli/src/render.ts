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

import type { Decision, Message, Peer, PeerCompactions, Routine } from '@fleet/foundation-contracts'
import type { DownResult, LsResult, PeekResult, SendResult, UpResult } from '@fleet/foundation-contracts'

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
  const lines = [
    `${status.profile}  pid ${String(status.pid)}  up since ${status.startedAt}`,
    `socket  ${status.socketPath}`,
    `store   ${status.storePath}`,
    '',
    ...section('peers', result.peers.length, columns(result.peers.map(peerRow)), 'none registered'),
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
    ...section('decisions', result.decisions.length, decisionRows, 'nothing waiting on the user'),
  ]
  return lines.join('\n')
}

export const formatUp = (result: UpResult): string =>
  [`${result.profile} up, pid ${String(result.pid)}`, `socket  ${result.socketPath}`, `store   ${result.storePath}`].join(
    '\n',
  )

export const formatDown = (_result: DownResult): string => 'fleetd stopped'

export const formatSend = (result: SendResult, peer: string): string => `sent ${result.msgId} to ${peer}`

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
