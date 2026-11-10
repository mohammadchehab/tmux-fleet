/**
 * The daily standup (architecture §5.2 `standup`, §6.1): a report rendered from
 * the projections, with no model call.
 *
 * It is a pure function over a snapshot for the same reason `decide` is (§5.2):
 * the day's report is a function of the day's state, so it can be re-rendered
 * from the log for any past date and compared with what was sent. Nothing here
 * reads a store, a clock or a provider — the caller hands in the rows and the
 * date.
 *
 * What it says, and why each part earns its lines: who is running and what they
 * are stuck on (a peer nobody hears from is the failure §6 exists to surface),
 * how much work sits in each state (a `ready` pile that never moves is the
 * signal), what is open at the PR gate, and what is waiting on the user — that
 * last one twice, because an unread decision is the only thing in the fleet
 * that stops dead until a human moves.
 */

import type { Decision, Peer, PullRequest, Work } from '@fleet/foundation-contracts'

/** The rows the report is rendered from; a subset of `ReadModel`, taken as one snapshot (§3). */
export interface StandupState {
  readonly peers: readonly Peer[]
  readonly work: readonly Work[]
  readonly pullRequests: readonly PullRequest[]
  readonly decisions: readonly Decision[]
}

export interface Standup {
  /** The whole report, as `standup.rendered.text` carries it. */
  readonly text: string
  readonly peers: number
  readonly openDecisions: number
}

/** A column width that keeps the peer block readable without measuring a terminal. */
const idWidth = 16

const pad = (value: string, width: number): string => (value.length >= width ? value : value.padEnd(width))

/** `engineer-1   engineer   working   2 pending` — one line, aligned, no colour. */
const peerLine = (peer: Peer, pending: number): string =>
  [
    pad(peer.peerId, idWidth),
    pad(peer.role, 12),
    pad(peer.state, 16),
    pending === 0 ? '' : `${pending} pending`,
  ]
    .join(' ')
    .trimEnd()

/**
 * Work by state, in §5.1's order rather than alphabetically: the pipeline reads
 * as a pipeline, so a pile-up is where you expect to see it.
 */
const WORK_ORDER = ['proposed', 'needs_contract', 'ready', 'assigned', 'in_progress', 'in_review', 'mergeable', 'merged', 'blocked', 'cancelled'] as const

const countByState = (work: readonly Work[]): readonly { readonly state: string; readonly count: number }[] =>
  WORK_ORDER.map((state) => ({ state, count: work.filter((item) => item.state === state).length })).filter(
    (row) => row.count > 0,
  )

/** An open PR with the one fact that says whether it can move: its checks. */
const prLine = (pr: PullRequest): string =>
  `${String(pr.repo)}#${pr.number}  ${pr.base}←${pr.head}  checks ${pr.checks}  review ${pr.review}`

export const renderStandup = (state: StandupState, date: string, pending: ReadonlyMap<string, number> = new Map()): Standup => {
  const open = state.decisions.filter((decision) => decision.state === 'open')
  const lines: string[] = [`Standup ${date}`, '']

  lines.push(`Peers (${state.peers.length})`)
  if (state.peers.length === 0) lines.push('  none')
  for (const peer of state.peers) lines.push(`  ${peerLine(peer, pending.get(peer.peerId) ?? 0)}`)

  const work = countByState(state.work)
  lines.push('', `Work (${state.work.length})`)
  if (work.length === 0) lines.push('  none')
  else lines.push(`  ${work.map((row) => `${row.state} ${row.count}`).join(' · ')}`)

  const prs = state.pullRequests.filter((pr) => !pr.merged)
  lines.push('', `Pull requests (${prs.length})`)
  if (prs.length === 0) lines.push('  none')
  for (const pr of prs) lines.push(`  ${prLine(pr)}`)

  lines.push('', `Waiting on you (${open.length})`)
  if (open.length === 0) lines.push('  nothing')
  for (const decision of open) lines.push(`  ${decision.decisionId}  ${decision.kind}: ${decision.question}`)

  return { text: lines.join('\n'), peers: state.peers.length, openDecisions: open.length }
}
