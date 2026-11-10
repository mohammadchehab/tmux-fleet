/**
 * What a pane shows, as pure functions from a daemon answer to text.
 *
 * The same rules the CLI's `render.ts` keeps, for the same reasons: aligned
 * columns, one row per projection row, no colour, no boxes. A pane is narrower
 * than a terminal and often watched from across the room, so a state is printed
 * exactly as the projection spells it (`waiting_input`, `open`) rather than
 * translated into prose — two vocabularies for one field is how a client drifts
 * from the store.
 *
 * Nothing here decides anything and nothing here reads a clock: every line is a
 * function of the daemon's answer, which is what makes a pane a test with no
 * socket in it.
 */

import type { LsResult, Peer, PeerActivity } from '@fleet/foundation-contracts'

/** Wide enough for `worktree` and `provider`, which are the longest labels. */
const LABEL = 10

const field = (label: string, value: string): string => `  ${label.padEnd(LABEL)}${value}`

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

const timestamp = (value: string): string => {
  // `2026-11-10T12:59:55.123Z` -> `2026-11-10 12:59:55`: a pane has no room for
  // the parts of an ISO stamp that do not change anything a person reads.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(value)
  return match === null ? value : `${match[1] ?? ''} ${match[2] ?? ''}`
}

/** A pane is narrow and often read from across the room, so a target is cut, not wrapped. */
const TARGET = 40

const shorten = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`

/** The tool line: the name always, the adapter's short target if it gave one. */
const tool = (activity: PeerActivity | undefined): string => {
  if (activity?.lastTool === undefined) return 'none'
  if (activity.lastTarget === undefined) return activity.lastTool
  return `${activity.lastTool} ${shorten(activity.lastTarget, TARGET)}`
}

/**
 * One peer, as the lines of its pane. The first line is the identity and the
 * state, because those are what a wall of panes is scanned for; everything else
 * is a labelled field underneath.
 *
 * `working` alone does not say what the peer is working on, so the activity row
 * — when the projection has one — adds the Work, the last tool and its short
 * target, how many edits that Work has taken, and when the last turn ended.
 * Every line is a projection value; nothing here infers activity from the state.
 */
export const renderPeer = (peer: Peer, activity?: PeerActivity): readonly string[] => [
  `${peer.peerId}  ${peer.state}`,
  field('role', peer.role),
  field('provider', `${peer.providerId}/${peer.model}`),
  field('session', peer.currentSessionId ?? 'none'),
  field('brief', `v${String(peer.briefVersion)}`),
  field('worktree', peer.worktreeId ?? 'none'),
  field('work', activity?.workId ?? 'none'),
  field('tool', tool(activity)),
  ...(activity?.workId === undefined ? [] : [field('edits', String(activity.edits))]),
  field('turn', activity?.lastTurnAt === undefined ? 'no turn yet' : timestamp(activity.lastTurnAt)),
  field('updated', timestamp(peer.updatedAt)),
]

/**
 * A pane that could not read the daemon. It keeps the peer's name — the pane is
 * titled with it and a blank pane reads like a peer that has no state — and
 * says why, because the next tick may well succeed and a view that died on one
 * refused connection would be a view that has to be restarted by hand.
 */
export const renderPaneFailure = (peerId: string, reason: string): readonly string[] => [
  peerId,
  field('cannot', reason),
]

const peerRow = (peer: Peer): readonly string[] => [
  peer.peerId,
  peer.state,
  peer.role,
  `${peer.providerId}/${peer.model}`,
  `v${String(peer.briefVersion)}`,
  peer.currentSessionId ?? '-',
]

/**
 * The whole fleet in one block, for a terminal with no tmux in it: piped output,
 * a test, a session over ssh. Deliberately the same table `fleet ls` prints for
 * its peers section — one command's job is to keep running, the other's is to
 * be read once, and there is no reason for them to disagree about a row.
 */
export const renderTable = (result: LsResult): string => {
  const { status, peers } = result
  const rows =
    peers.length === 0
      ? ['  none registered']
      : columns([['PEER', 'STATE', 'ROLE', 'PROVIDER/MODEL', 'BRIEF', 'SESSION'], ...peers.map(peerRow)]).map(
          (line) => `  ${line}`,
        )
  return [
    `${status.profile}  pid ${String(status.pid)}  up since ${timestamp(status.startedAt)}`,
    `socket  ${status.socketPath}`,
    '',
    `peers (${String(peers.length)})`,
    ...rows,
  ].join('\n')
}

/**
 * What a pane says when the profile has peers in the store but the caller asked
 * the view for one that is not among them. Separate from a daemon failure: this
 * is a name that was never registered, so waiting will not fix it.
 */
export const renderUnknownPeer = (peerId: string): readonly string[] => [
  peerId,
  field('unknown', 'no peer by that id in this fleet'),
]
