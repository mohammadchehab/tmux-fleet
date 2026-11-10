/**
 * Contracts and briefs (§12), pull requests (§10) and the build ledger (§11).
 * A Contract is published when a spec file is merged and hashed; a Brief is
 * immutable and superseded, never edited.
 */

import { array, event, object, optional, oneOf, positiveInt, string, text } from '@fleet/foundation-core'
import { briefId, contractId, peerId, sha, workId } from '@fleet/foundation-core'
import { branchName, contentHash, filePath, line, pullRequestRef } from '../shapes.ts'
import { repo } from '@fleet/foundation-core'

/**
 * A contract version is live: the spec file is in the repo and its hash is
 * recorded, so dependent Work can be assigned against exactly this layout
 * (§12). A new version supersedes dependent briefs (§5.2 `stale`).
 */
export const contractPublished = event(
  'contract.published',
  object({
    contractId: contractId(),
    version: positiveInt(),
    /** The spec file's path in the repo. */
    path: filePath(),
    contentHash: contentHash(),
    /** The Work item that wrote it, when the contract itself was contracted work. */
    workId: optional(workId()),
  }),
)

/** An immutable brief. `contractVersions` is what makes a stale brief detectable (§12). */
export const briefPublished = event(
  'brief.published',
  object({
    briefId: briefId(),
    workId: workId(),
    peerId: peerId(),
    version: positiveInt(),
    contractVersions: array(object({ contractId: contractId(), version: positiveInt() })),
    text: text(100_000),
  }),
)

/**
 * A brief was replaced because a contract it named moved on (§5.2 `stale`,
 * §12). The old one stays readable; nothing is edited in place.
 */
export const briefSuperseded = event(
  'brief.superseded',
  object({ briefId: briefId(), version: positiveInt(), supersededBy: briefId(), reason: text(500) }),
)

// -------------------------------------------------------------- pull requests

export const checksStates = ['pending', 'passing', 'failing'] as const
export type ChecksState = (typeof checksStates)[number]

export const reviewStates = ['pending', 'approved', 'changes_requested'] as const
export type ReviewState = (typeof reviewStates)[number]

/** A PR exists, or its head moved. `headSha` is what the gate must see green (§10). */
export const prOpened = event(
  'pr.opened',
  object({
    pr: pullRequestRef(),
    base: branchName(),
    head: branchName(),
    headSha: sha(),
    workId: optional(workId()),
    /** A stacked PR names its parent; the gate retargets dependents before merging (§10). */
    stackParent: optional(pullRequestRef()),
  }),
)

export const prChecks = event(
  'pr.checks',
  object({
    pr: pullRequestRef(),
    headSha: sha(),
    state: oneOf(checksStates),
    /** The failing check names, so a nudge can cite them. */
    failing: array(string({ minLength: 1, maxLength: 100 })),
  }),
)

export const prReview = event(
  'pr.review',
  object({
    pr: pullRequestRef(),
    headSha: sha(),
    state: oneOf(reviewStates),
    reviewer: optional(peerId()),
  }),
)

/** The gate merged it. Never `--delete-branch` while a dependent exists (§10). */
export const prMerged = event(
  'pr.merged',
  object({ pr: pullRequestRef(), headSha: sha(), mergeSha: optional(sha()) }),
)

/** A stack parent merged: dependents move to the parent's base before anything is merged (§10). */
export const prRetargeted = event(
  'pr.retargeted',
  object({ pr: pullRequestRef(), fromBase: branchName(), toBase: branchName() }),
)

/** CI failed after its retries: a failure notification class (§6.1). */
export const ciFailedFinal = event(
  'ci.failed_final',
  object({
    pr: pullRequestRef(),
    headSha: sha(),
    check: string({ minLength: 1, maxLength: 200 }),
    attempts: positiveInt(),
  }),
)

// --------------------------------------------------------------------- builds

/** Hosts a build can run on; heavy tasks route to the remote host by profile (§11). */
export const buildHosts = ['local', 'remote'] as const
export type BuildHost = (typeof buildHosts)[number]

/**
 * A peer asks for a build. The ledger is unique on `(repo, sha, task)`; a
 * second request for the same triple returns the existing result and appends
 * nothing (§11).
 */
export const buildRequested = event(
  'build.requested',
  object({
    buildId: string({ minLength: 1, maxLength: 80 }),
    repo: repo(),
    sha: sha(),
    task: string({ minLength: 1, maxLength: 100 }),
    host: oneOf(buildHosts),
    requestedBy: optional(peerId()),
  }),
)

export const buildStatuses = ['succeeded', 'failed', 'cancelled'] as const
export type BuildStatus = (typeof buildStatuses)[number]

export const buildFinished = event(
  'build.finished',
  object({
    buildId: string({ minLength: 1, maxLength: 80 }),
    repo: repo(),
    sha: sha(),
    task: string({ minLength: 1, maxLength: 100 }),
    status: oneOf(buildStatuses),
    logPath: optional(string({ minLength: 1 })),
    durationMs: positiveInt(),
  }),
)
