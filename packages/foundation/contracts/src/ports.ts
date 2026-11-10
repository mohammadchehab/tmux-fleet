/**
 * Ports: what one group needs from another, declared here so the groups never
 * import each other sideways (architecture §1.1). `apps/daemon` injects the
 * implementation; `pm` and `gate` are testable against a fake with no `gh` and
 * no git.
 */

import type {
  DecisionId,
  FleetError,
  NotificationKey,
  PeerId,
  Repo,
  Result,
  Seq,
  SessionId,
  Sha,
  TurnId,
  WorkId,
} from '@fleet/foundation-core'
import type { ChecksState, ReviewState } from './events/delivery.ts'
import type { AppendEvent } from './events/registry.ts'
import type { Message } from './projections/mailbox.ts'
import type { MessageAckState } from './events/messages.ts'
import type { ProviderHandle, Turn } from './provider.ts'
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
  searchIntent(repo: Repo, text: string): Promise<readonly PullRequest[]>

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

  /**
   * Merge, pinned to the sha the caller decided on. `headSha` is not advice: an
   * implementation passes it to the forge as the head the merge must find
   * (`gh pr merge --match-head-commit`), so a push that lands between the caller's
   * read and this call fails the merge instead of landing a commit nobody checked
   * (§10). There is no unpinned merge in this port on purpose. A refusal because
   * the head moved is a `FleetError` with code `head_moved`.
   */
  merge(
    repo: Repo,
    number: number,
    options: { readonly method: 'merge' | 'squash' | 'rebase'; readonly deleteBranch: boolean; readonly headSha: Sha },
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
    /**
     * Every session the fleet has, oldest first. A session belongs to a peer,
     * but a `FleetState` needs all of them (§5.2), and asking per peer made the
     * snapshot's cost a function of the fleet's size rather than one read.
     */
    all(): Promise<readonly Session[]>
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
  /** §7's projection: what the Mailbox wrote, and what `fleet peek` reads. */
  readonly messages: {
    all(): Promise<readonly Message[]>
    /** One peer's messages; `states` narrows it, and is what the pending read of §7 asks for. */
    forPeer(id: PeerId, states?: readonly MessageAckState[]): Promise<readonly Message[]>
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

// ------------------------------------------------------------------ mailbox (§7)

/**
 * The append-only write port: the one way into the store (§3, §5.4). Narrow on
 * purpose — the Mailbox writes messages and reads them back, so that is all it
 * is given, and a fake in memory is enough to test it before the SQLite store
 * lands (§15). `EventStore` in `@fleet/foundation-store` satisfies it
 * structurally; `apps/daemon` passes that implementation in.
 */
export interface EventSink {
  /** Append a batch atomically. Returns the seqs, in the order given. */
  append(batch: readonly AppendEvent[]): Promise<readonly Seq[]>
}

/**
 * The read side the Mailbox needs: the `message` projection for one peer (§3,
 * §7). `states` is part of the read rather than a filter applied afterwards, so
 * the pending and delivery reads touch only the rows they can still act on:
 * `messages_pending (to_peer, state)` in the store DDL is that query (§15).
 * Omitted means every state, which is what `history` and `find` want.
 */
export interface MessageReader {
  forPeer(peerId: PeerId, states?: readonly MessageAckState[]): Promise<readonly Message[]>
}

/**
 * The brief version a peer's context is on (§7, §12). The Mailbox reads it to
 * reject a reply or status that cites an older one, and attaches the current
 * version so the sender can re-send correctly.
 */
export interface BriefVersions {
  /** The version the peer's context carries, or `undefined` before it has a brief. */
  current(peerId: PeerId): Promise<number | undefined>
}

/**
 * A live session the Mailbox can hand messages to (§4, §7). It is a thin
 * closure over `Provider.send` and the handle the supervisor holds, so the
 * Mailbox never depends on a provider and never sees a vendor session ref.
 */
export interface PeerSessionLease {
  readonly sessionId: SessionId
  /** True when a session had to be started or resumed to produce this lease (§7). */
  readonly resumed: boolean
  /** One provider call — a turn, never keystrokes (§4, §7). */
  send(turn: Turn): Promise<TurnId>
}

/**
 * How the Mailbox reaches a peer. `acquire` is resume-then-deliver in one call
 * on purpose (§7): the supervisor starts or resumes a session if the peer has
 * none, so a caller cannot forget the resume and nothing is sent to a dead
 * socket. An offline peer is a typed `Result`, not a throw.
 */
export interface PeerSessions {
  acquire(peerId: PeerId): Promise<Result<PeerSessionLease, FleetError>>
}
