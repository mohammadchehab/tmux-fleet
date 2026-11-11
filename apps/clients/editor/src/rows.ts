/**
 * What the tree says (§4): the needs-you list and the peer rows, computed from
 * one `ls` and nothing else.
 *
 * This is the file that keeps the extension honest about being a client: it
 * holds no state, it derives every word from the daemon's projections, and it
 * is pure, so the rows `fleet watch` will draw and the rows the editor draws
 * come from one function instead of two readings of the same JSON. When
 * `@fleet/client-view-model` lands (§3) this becomes its editor-side half; until
 * then this is the whole of the row logic, and its tests are the proof.
 *
 * Two things it does *not* invent:
 *
 * - **A context percentage.** `ls` carries tokens and turns but not the limit,
 *   so "17%" would be a guess. The row says what the peer is doing and how many
 *   turns it has run; the tooltip carries the tokens and the cost. When the
 *   limit is in the stream the percentage goes in the same place.
 * - **A purge threshold.** The warning mark is drawn for a peer that has
 *   compacted, which is the observable fact behind it, rather than for one that
 *   is 80% of the way to a limit this client cannot see.
 */

import type { Decision, LsResult, PeerActivity, PeerCompactions, TokenReport } from '@fleet/foundation-contracts'
import type { PeerId, PeerState } from '@fleet/foundation-core'

import { actionsFor, standingOf, type PeerAction } from './actions.ts'

/** The themed icon a row asks for; the editor layer turns it into a `ThemeIcon`. */
export type PeerMark = 'working' | 'waiting' | 'idle' | 'starting' | 'ended' | 'failed'

export interface PeerRow {
  /** The element identity: stable across polls, which is what single-row refresh needs (§4). */
  readonly id: string
  readonly peerId: PeerId
  readonly label: string
  readonly description: string
  readonly tooltip: string
  readonly mark: PeerMark
  readonly state: PeerState
  readonly warning: boolean
  readonly actions: readonly PeerAction[]
}

export interface NeedYouRow {
  readonly id: string
  readonly kind: 'decision' | 'input'
  readonly label: string
  readonly description: string
  readonly tooltip: string
  readonly decision?: Decision
  readonly peerId?: PeerId
}

export interface FleetRows {
  readonly needsYou: readonly NeedYouRow[]
  readonly peers: readonly PeerRow[]
}

const markOf = (state: PeerState): PeerMark => {
  switch (state) {
    case 'working':
      return 'working'
    case 'waiting_input':
      return 'waiting'
    case 'idle':
      return 'idle'
    case 'starting':
      return 'starting'
    case 'ended':
      return 'ended'
    case 'failed':
      return 'failed'
  }
}

const activityOf = (rows: readonly PeerActivity[], peerId: PeerId): PeerActivity | undefined =>
  rows.find((row) => row.peerId === peerId)

/** The rollup row for a peer (`workId` absent) when there is one, else what its works add up to. */
const tokensOf = (rows: readonly TokenReport[], peerId: PeerId): TokenReport | undefined => {
  const mine = rows.filter((row) => row.peerId === peerId)
  const rollup = mine.find((row) => row.workId === undefined)
  if (rollup !== undefined) return rollup
  if (mine.length === 0) return undefined
  const sum = (pick: (row: TokenReport) => number): number => mine.reduce((total, row) => total + pick(row), 0)
  const first = mine[0]
  if (first === undefined) return undefined
  return {
    ...first,
    turns: sum((row) => row.turns),
    inputTokens: sum((row) => row.inputTokens),
    outputTokens: sum((row) => row.outputTokens),
    cachedTokens: sum((row) => row.cachedTokens),
    costUsd: sum((row) => row.costUsd),
  }
}

const compactionsOf = (rows: readonly PeerCompactions[], peerId: PeerId): PeerCompactions | undefined =>
  rows.find((row) => row.peerId === peerId)

/** "Read src/mailbox.ts", "work TASK-4", or what the state itself says. */
const doingNow = (state: PeerState, activity: PeerActivity | undefined): string => {
  const tool = activity?.lastTool
  if (tool !== undefined) return activity?.lastTarget === undefined ? tool : `${tool} ${activity.lastTarget}`
  if (activity?.workId !== undefined) return `work ${activity.workId}`
  switch (state) {
    case 'waiting_input':
      return 'waiting for you'
    case 'starting':
      return 'starting'
    case 'idle':
      return 'idle'
    case 'ended':
      return 'ended'
    case 'failed':
      return 'failed'
    case 'working':
      return 'working'
  }
}

const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`

const tooltipOf = (
  label: string,
  state: PeerState,
  tokens: TokenReport | undefined,
  compactions: PeerCompactions | undefined,
): string => {
  const lines = [label, `state: ${state}`]
  if (tokens !== undefined) {
    lines.push(`turns: ${String(tokens.turns)}`)
    lines.push(`tokens: ${String(tokens.inputTokens)} in / ${String(tokens.outputTokens)} out`)
    if (tokens.costUsd > 0) lines.push(`cost: $${tokens.costUsd.toFixed(2)}`)
  }
  if (compactions !== undefined && compactions.count > 0) {
    lines.push(`context: compacted ${plural(compactions.count, 'time', 'times')}, last ${compactions.lastAt}`)
  }
  return lines.join('\n')
}

/**
 * One `ls` as the two lists the tree shows. Peer order is by id so a row keeps
 * its place between polls — an order that follows `ls` would move a row every
 * time the store's own order changed, and a moving tree is one nobody can click.
 */
export const rowsOf = (ls: LsResult): FleetRows => {
  const decisions: readonly Decision[] = ls.decisions.filter((decision) => decision.state === 'open')

  const waiting = ls.peers
    .filter((peer) => peer.state === 'waiting_input')
    .slice()
    .sort((a, b) => a.peerId.localeCompare(b.peerId))

  const needsYou: readonly NeedYouRow[] = [
    ...decisions.map((decision) => ({
      id: `decision:${decision.decisionId}`,
      kind: 'decision' as const,
      label: decision.question,
      description: decision.kind,
      tooltip: [decision.question, `asked ${decision.requestedAt}`, ...decision.options.map((o) => `· ${o}`)].join('\n'),
      decision,
    })),
    ...waiting.map((peer) => ({
      id: `input:${peer.peerId}`,
      kind: 'input' as const,
      label: `${peer.peerId} is waiting for input`,
      description: 'waiting',
      tooltip: `${peer.peerId} is waiting for you. Take it over to answer.`,
      peerId: peer.peerId,
    })),
  ]

  const peers: readonly PeerRow[] = ls.peers
    .slice()
    .sort((a, b) => a.peerId.localeCompare(b.peerId))
    .map((peer) => {
      const activity = activityOf(ls.activity, peer.peerId)
      const tokens = tokensOf(ls.tokens, peer.peerId)
      const compactions = compactionsOf(ls.compactions, peer.peerId)
      const doing = doingNow(peer.state, activity)
      const turns = tokens === undefined ? '' : ` · ${plural(tokens.turns, 'turn', 'turns')}`
      return {
        id: peer.peerId,
        peerId: peer.peerId,
        label: peer.peerId,
        description: `${doing}${turns}`,
        tooltip: tooltipOf(peer.peerId, peer.state, tokens, compactions),
        mark: markOf(peer.state),
        state: peer.state,
        warning: (compactions?.count ?? 0) > 0,
        actions: actionsFor(standingOf(peer.state)),
      }
    })

  return { needsYou, peers }
}

export const countOf = (rows: FleetRows): number => rows.needsYou.length
