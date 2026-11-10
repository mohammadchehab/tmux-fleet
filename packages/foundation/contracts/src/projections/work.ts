/**
 * `Work`, `Contract` and `Brief` projections (architecture §3, §5.1, §12).
 * A Brief is immutable: it is superseded, never edited, so a peer's context
 * can always be traced to the exact text it was given.
 */

import {
  array,
  boolean,
  object,
  optional,
  positiveInt,
  string,
  text,
  timestamp,
  type Schema,
} from '@fleet/foundation-core'
import { briefId, contractId, peerId, workId } from '@fleet/foundation-core'
import { workState } from '../work-state.ts'
import { externalRef, line, pullRequestRef } from '../shapes.ts'
import type { WorkState } from '../work-state.ts'
import type { BriefId, ContractId, PeerId, WorkId } from '@fleet/foundation-core'
import type { ExternalRef, PullRequestRef } from '../shapes.ts'

export interface Work {
  readonly workId: WorkId
  readonly title: string
  readonly state: WorkState
  /** The role this Work is for; the PM's `assign` rule matches a peer's role (§5.2). */
  readonly role?: string
  readonly body?: string
  readonly assignee?: PeerId
  readonly contractId?: ContractId
  /** Work or Contract ids this one waits for (§5.2, §12). */
  readonly dependsOn: readonly string[]
  readonly prs: readonly PullRequestRef[]
  readonly external?: ExternalRef
  /** The current brief, and the version, for the `stale` rule (§5.2). */
  readonly briefId?: BriefId
  readonly briefVersion?: number
  readonly blockedReason?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export const work = (): Schema<Work> =>
  object({
    workId: workId(),
    title: line(),
    state: workState(),
    role: optional(line(80)),
    body: optional(text(20_000)),
    assignee: optional(peerId()),
    contractId: optional(contractId()),
    dependsOn: array(string({ minLength: 1, maxLength: 80 }), { maxItems: 100 }),
    prs: array(pullRequestRef(), { maxItems: 50 }),
    external: optional(externalRef()),
    briefId: optional(briefId()),
    briefVersion: optional(positiveInt()),
    blockedReason: optional(text(1000)),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  }) as Schema<Work>

export interface Contract {
  readonly contractId: ContractId
  readonly version: number
  /** A published contract is one dependent Work may be assigned against (§12). */
  readonly published: boolean
  readonly path: string
  readonly contentHash: string
  readonly workId?: WorkId
  readonly updatedAt: string
}

export const contract = (): Schema<Contract> =>
  object({
    contractId: contractId(),
    version: positiveInt(),
    published: boolean(),
    path: line(500),
    contentHash: line(64),
    workId: optional(workId()),
    updatedAt: timestamp(),
  }) as Schema<Contract>

export interface ContractVersionRef {
  readonly contractId: ContractId
  readonly version: number
}

export const contractVersionRef = (): Schema<ContractVersionRef> =>
  object({ contractId: contractId(), version: positiveInt() }) as Schema<ContractVersionRef>

export interface Brief {
  readonly briefId: BriefId
  readonly workId: WorkId
  readonly peerId: PeerId
  readonly version: number
  readonly contractVersions: readonly ContractVersionRef[]
  readonly text: string
  readonly createdAt: string
  /** Set when a newer contract superseded it; the row stays readable (§12). */
  readonly supersededBy?: BriefId
}

export const brief = (): Schema<Brief> =>
  object({
    briefId: briefId(),
    workId: workId(),
    peerId: peerId(),
    version: positiveInt(),
    contractVersions: array(contractVersionRef()),
    text: text(100_000),
    createdAt: timestamp(),
    supersededBy: optional(briefId()),
  }) as Schema<Brief>
