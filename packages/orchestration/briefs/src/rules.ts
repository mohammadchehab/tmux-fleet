/**
 * What makes a brief publishable, as pure functions (§12). Kept apart from the
 * calls that carry them out so a test asks "may this brief go out?" for every
 * state of the Work and the peer without a fake store, and so a rule cannot be
 * reordered by whoever edits the sequence of effects.
 *
 * A Brief is immutable and its version is per peer: the peer's context carries
 * one version, the Mailbox rejects a reply citing an older one (§7), and the
 * `stale` rule supersedes a brief rather than editing it. That is why a version
 * may only go up.
 */

import type { BriefHandoff, Peer, SupersedeBriefAction, Work } from '@fleet/foundation-contracts'

/** Why a brief is not published. Closed, so the PM and the notifier can act on the reason. */
export const briefRefusals = [
  'work_missing',
  'peer_missing',
  'work_not_assignable',
  'work_assigned_elsewhere',
  'version_not_newer',
  'superseding_something_else',
] as const
export type BriefRefusal = (typeof briefRefusals)[number]

/** Facts read when the action runs. */
export interface BriefFacts {
  readonly work?: Work
  readonly peer?: Peer
}

/** The brief is already the Work's current one, for the same peer: a retry of an action that got part-way. */
export const alreadyPublished = (brief: BriefHandoff, facts: BriefFacts, peerId: string): boolean =>
  facts.work?.briefId === brief.briefId && facts.work.assignee === peerId

const versionGoesUp = (brief: BriefHandoff, peer: Peer): boolean => brief.version > peer.briefVersion

/** `assign`: a `ready` Work, a known peer, a version above what the peer carries (§5.2, §12). */
export const assignRefusal = (brief: BriefHandoff, peerId: string, facts: BriefFacts): BriefRefusal | undefined => {
  const { work, peer } = facts
  if (work === undefined) return 'work_missing'
  if (peer === undefined) return 'peer_missing'
  if (alreadyPublished(brief, facts, peerId)) return undefined
  if (work.state !== 'ready') return 'work_not_assignable'
  if (work.assignee !== undefined && work.assignee !== peerId) return 'work_assigned_elsewhere'
  if (!versionGoesUp(brief, peer)) return 'version_not_newer'
  return undefined
}

/**
 * `supersede_brief`: the Work's current brief must be the one the PM decided
 * against (the inputs did not move), and the replacement must be newer (§5.4).
 */
export const supersedeRefusal = (action: SupersedeBriefAction, facts: BriefFacts): BriefRefusal | undefined => {
  const { work, peer } = facts
  if (work === undefined) return 'work_missing'
  if (peer === undefined) return 'peer_missing'
  if (alreadyPublished(action.brief, facts, action.peerId)) return undefined
  if (work.assignee !== action.peerId) return 'work_assigned_elsewhere'
  if (work.briefId !== action.supersededBriefId || work.briefVersion !== action.supersededVersion) {
    return 'superseding_something_else'
  }
  if (!versionGoesUp(action.brief, peer)) return 'version_not_newer'
  return undefined
}

export const describeBriefRefusal = (refusal: BriefRefusal, what: string): string => {
  switch (refusal) {
    case 'work_missing':
      return `${what}: the Work does not exist`
    case 'peer_missing':
      return `${what}: the peer is not registered`
    case 'work_not_assignable':
      return `${what}: the Work is not ready, so it is not assigned`
    case 'work_assigned_elsewhere':
      return `${what}: the Work belongs to another peer`
    case 'version_not_newer':
      return `${what}: the brief version is not above the one the peer carries; versions only go up`
    case 'superseding_something_else':
      return `${what}: the Work's current brief is not the one this decision was made against, so the inputs moved`
  }
}
