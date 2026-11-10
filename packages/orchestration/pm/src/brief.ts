/**
 * The Brief the PM hands a peer (architecture §5.2 `assign`/`stale`, §7, §12).
 *
 * The text is deterministic: the same Work, peer and versions produce the same brief, which is what lets a replay
 * compare two briefs and a supersede name exactly what the peer used to hold. Nothing here reads a clock or a
 * model — a brief that varied would make every `assign` diff, and §5.4's replay a false positive.
 *
 * `contractVersions` is where §12's staleness lives. A `FleetState` carries the Work's current *brief* version but
 * no Contract projection, so the version a brief names comes from the event that made it relevant: a
 * `contract.published` names its own version, and `work.briefVersion` names the one the peer is on now.
 */

import type { BriefHandoff, ContractVersionRef, Peer, Work } from '@fleet/foundation-contracts'
import type { BriefId } from '@fleet/foundation-core'
import { deriveId } from './digest.ts'
import { prKey } from './state.ts'

export type BriefReason = 'assign' | 'supersede'

/**
 * The brief's id, derived from what it is about: the same Work at the same version for the same peer is the same
 * brief, so a re-run of `decide` names the row it already wrote instead of minting a second one (§5.4).
 */
export const briefIdFor = (work: Work, peer: Peer, version: number): BriefId =>
  deriveId('brf', { workId: work.workId, peerId: peer.peerId, version }) as BriefId

const contractsLine = (work: Work, contractVersions: readonly ContractVersionRef[]): string => {
  if (contractVersions.length > 0) {
    return `Contracts: ${contractVersions.map((ref) => `${String(ref.contractId)} v${ref.version}`).join(', ')}`
  }
  if (work.contractId !== undefined) {
    // The version is not in the snapshot; the executor publishes the brief and fills the live one (§12)
    return `Contracts: ${String(work.contractId)} — version confirmed by the executor when this brief is published`
  }
  return 'Contracts: none — this Work names no shared contract.'
}

export interface BriefInput {
  readonly work: Work
  readonly peer: Peer
  readonly version: number
  readonly contractVersions: readonly ContractVersionRef[]
  readonly reason: BriefReason
}

/** The brief's text: what the peer is being asked for, by whom, against which contract versions (§12). */
export const briefText = ({ work, peer, version, contractVersions, reason }: BriefInput): string => {
  const body = work.body?.trim()
  const lines = [
    `Brief v${version} — ${peer.peerId} (${peer.role}) · ${reason === 'assign' ? 'new Work' : 'superseded: the contract moved on'}`,
    '',
    `Work ${String(work.workId)}: ${work.title}`,
    body === undefined || body === '' ? 'No description on the card. Ask the PM before guessing at the goal.' : body,
    '',
    contractsLine(work, contractVersions),
  ]

  // §3's read-only context: a Work that came from a board says which card it is,
  // so a peer can read the ticket a human actually filed — and put the key in
  // the PR — without being handed the board as writable. The title and body
  // above are already the card's, read with `Tracker.get` when it was proposed;
  // this line is the key and where to open it.
  if (work.external !== undefined) {
    const { system, key, url } = work.external
    lines.push(url === undefined ? `Ticket: ${system} ${key}` : `Ticket: ${system} ${key} — ${url}`)
  }

  if (work.dependsOn.length > 0) lines.push(`Waits for: ${work.dependsOn.join(', ')}`)
  if (work.prs.length > 0) lines.push(`Pull requests: ${work.prs.map((pr) => prKey(pr)).join(', ')}`)

  lines.push(
    '',
    `Deliver a PR against main. Report status against brief version ${version}: a reply that cites an older one is rejected (§7).`,
  )
  return lines.join('\n')
}

/** The complete `BriefHandoff` an `assign` or `supersede_brief` action carries (§5.2). */
export const briefFor = (input: BriefInput): BriefHandoff => ({
  briefId: briefIdFor(input.work, input.peer, input.version),
  version: input.version,
  contractVersions: input.contractVersions,
  text: briefText(input),
})
