/**
 * Reading a `FleetState` (architecture §3, §5.2): indexes over the snapshot, and the ordering every rule
 * iterates in.
 *
 * The ordering matters more than it looks. `decide` must return the same actions in the same order for the same
 * inputs (§5.4), and a snapshot's arrays come out of a store in whatever order the rows were written. So no rule
 * iterates a projection directly: it sorts by a stable key first, and the two rules that must agree on which Work
 * is "the" match (dedupe, assign) then cannot depend on how the store happened to answer.
 */

import type { DecisionId, PeerId } from '@fleet/foundation-core'
import { isWorkTerminal } from '@fleet/foundation-contracts'
import type { Decision, FleetState, Peer, PullRequest, PullRequestRef, Work } from '@fleet/foundation-contracts'

/** `repo#number`: a PR's identity in a claim, a log line and a `PullRequestRef` lookup. */
export const prKey = (pr: PullRequestRef): string => `${String(pr.repo)}#${pr.number}`

/** The ref a `PmAction` carries: only the two fields the schema allows, never the whole projection. */
export const refOf = (pr: PullRequest): PullRequestRef => ({ repo: pr.repo, number: pr.number })

/** A comparator over a row's stable key: the only way a rule orders a projection. */
export const byOrder =
  <T>(key: (row: T) => string) =>
  (a: T, b: T): number => {
    const left = key(a)
    const right = key(b)
    return left < right ? -1 : left > right ? 1 : 0
  }

/** Creation order, then id: what "the next Work to hand out" means when two were proposed in the same millisecond. */
export const workOrder = (work: Work): string => `${work.createdAt}|${work.workId}`

export const prOrder = (pr: PullRequest): string => `${String(pr.repo)}|${String(pr.number).padStart(8, '0')}`

/** A peer that is still in the fleet: `ended` and `failed` are not, so they neither take Work nor answer questions. */
export const isLivePeer = (peer: Peer): boolean => peer.state !== 'ended' && peer.state !== 'failed'

export interface StateIndex {
  readonly peer: (id: PeerId) => Peer | undefined
  readonly work: (id: string) => Work | undefined
  readonly pr: (ref: PullRequestRef) => PullRequest | undefined
  readonly decision: (id: DecisionId) => Decision | undefined
  /** Every peer holding a role, live or not: the caller decides whether a dead one counts. */
  readonly peersWithRole: (role: string) => readonly Peer[]
  /** The Work a PR belongs to, when the PR named one. */
  readonly workOfPr: (pr: PullRequest) => Work | undefined
  /** How many open PRs a peer's Work has: §5.2's cap is on PRs, not on Work items. */
  readonly openPrsOf: (id: PeerId) => number
  /** The PRs in a deterministic order, ready to iterate. */
  readonly prs: readonly PullRequest[]
}

export const indexOf = (state: FleetState): StateIndex => {
  const peers = new Map(state.peers.map((row) => [row.peerId, row]))
  // `PullRequest.workId` is the plain string the event carried, so Work is keyed as one too
  const work = new Map<string, Work>(state.work.map((row) => [String(row.workId), row]))
  const prs = new Map(state.pullRequests.map((row) => [prKey(refOf(row)), row]))
  const decisions = new Map(state.decisions.map((row) => [row.decisionId, row]))

  const peersWithRole = (role: string): readonly Peer[] =>
    state.peers.filter((row) => row.role === role).sort(byOrder((row) => row.peerId))

  const workOfPr = (pr: PullRequest): Work | undefined => (pr.workId === undefined ? undefined : work.get(pr.workId))

  const openPrsOf = (id: PeerId): number =>
    state.work
      .filter((row) => row.assignee === id && !isWorkTerminal(row.state))
      .reduce((count, row) => count + row.prs.length, 0)

  return {
    peer: (id) => peers.get(id),
    work: (id) => work.get(id),
    pr: (ref) => prs.get(prKey(ref)),
    decision: (id) => decisions.get(id),
    peersWithRole,
    workOfPr,
    openPrsOf,
    prs: [...state.pullRequests].sort(byOrder(prOrder)),
  }
}
