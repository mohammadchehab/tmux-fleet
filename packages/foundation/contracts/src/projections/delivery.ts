/**
 * `Worktree`, `PR` and `Build` projections (architecture §3, §9, §10, §11).
 * A worktree's class is computed from git/gh facts on events, never scanned on
 * demand; a build is unique on `(repo, sha, task)`.
 */

import { array, boolean, count, object, objectAs, oneOf, optional, positiveInt, string, timestamp, type Schema } from '@fleet/foundation-core'
import { peerId, sha, worktreeId } from '@fleet/foundation-core'
import { repo } from '@fleet/foundation-core'
import { branchName } from '../shapes.ts'
import { buildHosts, buildStatuses, checksStates, reviewStates } from '../events/delivery.ts'
import type { BuildHost, BuildStatus, ChecksState, ReviewState } from '../events/delivery.ts'
import type { PeerId, WorktreeId } from '@fleet/foundation-core'
import type { Repo, Sha } from '@fleet/foundation-core'

/** The five states a checkout can be in; only `active` is being worked in (§9). */
export const worktreeClasses = ['active', 'idle', 'merged', 'gone', 'orphaned'] as const
export type WorktreeClass = (typeof worktreeClasses)[number]

export interface Holder {
  readonly pid: number
  readonly command?: string
}

export const holder = (): Schema<Holder> =>
  objectAs<Holder>()({ pid: positiveInt(), command: optional(string({ maxLength: 200 })) })

export interface Worktree {
  readonly worktreeId: WorktreeId
  readonly repo: Repo
  readonly branch: string
  readonly path: string
  /** Recorded at creation, from an event — never an owner file (§9). */
  readonly ownerPeerId?: PeerId
  readonly class: WorktreeClass
  readonly dirty: boolean
  readonly unpushed: boolean
  /** Processes whose cwd is inside it; `gc` reports them and never kills them (§9). */
  readonly holders: readonly Holder[]
  readonly createdAt: string
  readonly updatedAt: string
}

export const worktree = (): Schema<Worktree> =>
  objectAs<Worktree>()({
    worktreeId: worktreeId(),
    repo: repo(),
    branch: branchName(),
    path: string({ minLength: 1, maxLength: 1000 }),
    ownerPeerId: optional(peerId()),
    class: oneOf(worktreeClasses),
    dirty: boolean(),
    unpushed: boolean(),
    holders: array(holder()),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  })

export interface PullRequest {
  readonly repo: Repo
  readonly number: number
  readonly base: string
  readonly head: string
  readonly headSha: Sha
  readonly checks: ChecksState
  /** The checks that are failing, when `checks` is `failing`. */
  readonly failingChecks: readonly string[]
  readonly review: ReviewState
  /** A stacked PR's parent; the gate retargets dependents before merging (§10). */
  readonly stackParent?: { readonly repo: Repo; readonly number: number }
  readonly workId?: string
  readonly merged: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export const pullRequest = (): Schema<PullRequest> =>
  objectAs<PullRequest>()({
    repo: repo(),
    number: positiveInt(),
    base: branchName(),
    head: branchName(),
    headSha: sha(),
    checks: oneOf(checksStates),
    failingChecks: array(string({ minLength: 1, maxLength: 200 })),
    review: oneOf(reviewStates),
    stackParent: optional(object({ repo: repo(), number: positiveInt() })),
    workId: optional(string({ minLength: 1, maxLength: 80 })),
    merged: boolean(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  })

export interface Build {
  readonly buildId: string
  readonly repo: Repo
  readonly sha: Sha
  readonly task: string
  readonly host: BuildHost
  readonly status: BuildStatus | 'running'
  readonly logPath?: string
  readonly durationMs?: number
  readonly startedAt: string
  readonly finishedAt?: string
}

export const build = (): Schema<Build> =>
  objectAs<Build>()({
    buildId: string({ minLength: 1, maxLength: 80 }),
    repo: repo(),
    sha: sha(),
    task: string({ minLength: 1, maxLength: 100 }),
    host: oneOf(buildHosts),
    status: oneOf([...buildStatuses, 'running']),
    logPath: optional(string({ minLength: 1 })),
    durationMs: optional(count()),
    startedAt: timestamp(),
    finishedAt: optional(timestamp()),
  })

/** The uniqueness key the ledger enforces (§11). */
export const buildKey = (repoName: string, shaValue: string, task: string): string =>
  `${repoName}/${shaValue}/${task}`
