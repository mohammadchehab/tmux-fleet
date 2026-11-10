/**
 * Ports: what one group needs from another, declared here so the groups never
 * import each other sideways (architecture §1.1). `apps/daemon` injects the
 * implementation; `pm` and `gate` are testable against a fake with no `gh` and
 * no git.
 */

import type { DecisionId, NotificationKey, PeerId, Repo, Sha, WorkId } from '@fleet/foundation-core'
import type { ChecksState, ReviewState } from './events/delivery.ts'
import type { ProviderHandle } from './provider.ts'
import type { PullRequest, Worktree } from './projections/delivery.ts'
import type { Decision, Finding, Notification, Routine } from './projections/ops.ts'
import type { Peer, Session } from './projections/peers.ts'
import type { Work } from './projections/work.ts'

/**
 * The PR surface `gate`, `pr-babysit` and the `dedupe` rule need (§5.2, §10).
 * Implemented by `@fleet/integrations-github` over `gh` and git (phase 1).
 */
export interface PullRequests {
  /** Open PRs for a repo; the gate and the retarget sweep walk these. */
  list(repo: Repo, options?: { readonly state?: 'open' | 'closed' | 'all' }): Promise<readonly PullRequest[]>

  get(repo: Repo, number: number): Promise<PullRequest | undefined>

  /** `dedupe`: search open PRs for the same intent before assigning work (§5.2). */
  search(repo: Repo, text: string): Promise<readonly PullRequest[]>

  create(input: {
    readonly repo: Repo
    readonly base: string
    readonly head: string
    readonly title: string
    readonly body?: string
  }): Promise<{ readonly repo: Repo; readonly number: number }>

  /** Checks on a PR's *current* head sha; the gate never merges on an older one (§10). */
  checks(repo: Repo, number: number): Promise<{ readonly state: ChecksState; readonly failing: readonly string[] }>

  review(repo: Repo, number: number): Promise<{ readonly state: ReviewState; readonly reviewer?: string }>

  /** Move a PR to a new base. Stacks are retargeted before a parent merges (§10). */
  retarget(repo: Repo, number: number, base: string): Promise<void>

  /** PRs whose `stackParent` is this one; a dependent forbids `--delete-branch` (§10). */
  dependents(repo: Repo, number: number): Promise<readonly { readonly repo: Repo; readonly number: number }[]>

  merge(
    repo: Repo,
    number: number,
    options: { readonly method: 'merge' | 'squash' | 'rebase'; readonly deleteBranch: boolean },
  ): Promise<{ readonly mergeSha?: Sha }>
}

/**
 * The providers that exist, by id. `supervisor` and `reconcile` resolve a
 * peer's provider through this; nothing else holds a provider instance (§2).
 *
 * Generic over the handle so `apps/daemon` can inject a registry of full
 * `Provider`s while `contracts` stays free of any provider implementation.
 */
export interface ProviderRegistry<P extends ProviderHandle = ProviderHandle> {
  get(id: string): P | undefined
  /** The provider, or a `FleetError` with code `not_found`. */
  require(id: string): P
  /** Ids in registration order. */
  ids(): readonly string[]
  register(provider: P): void
}

/**
 * A read-only view of the store's projections, so the PM, the standup and the
 * CLI read state without holding a store handle or the ability to append (§3,
 * §5.2, §5.4).
 */
export interface ReadModel {
  readonly peers: {
    all(): Promise<readonly Peer[]>
    get(id: PeerId): Promise<Peer | undefined>
  }
  readonly sessions: {
    forPeer(id: PeerId): Promise<readonly Session[]>
  }
  readonly work: {
    all(): Promise<readonly Work[]>
    get(id: WorkId): Promise<Work | undefined>
  }
  readonly decisions: {
    all(): Promise<readonly Decision[]>
    open(): Promise<readonly Decision[]>
    get(id: DecisionId): Promise<Decision | undefined>
  }
  readonly notifications: {
    all(): Promise<readonly Notification[]>
    get(key: NotificationKey): Promise<Notification | undefined>
  }
  readonly findings: {
    all(): Promise<readonly Finding[]>
  }
  readonly pullRequests: {
    all(): Promise<readonly PullRequest[]>
  }
  readonly worktrees: {
    all(): Promise<readonly Worktree[]>
  }
  readonly routines: {
    all(): Promise<readonly Routine[]>
  }
}
