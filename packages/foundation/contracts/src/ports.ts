/**
 * Ports: what one group needs from another, declared here so the groups never
 * import each other sideways (architecture §1.1). `apps/daemon` injects the
 * implementation; `pm` and `gate` are testable against a fake with no `gh` and
 * no git.
 */

import type {
  DecisionId,
  EvalRunId,
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
import type { EvalRunWithCases } from './projections/evals.ts'
import type { Message } from './projections/mailbox.ts'
import type { MessageAckState } from './events/messages.ts'
import type { ProviderHandle, Turn } from './provider.ts'
import type { Build, PullRequest, Worktree } from './projections/delivery.ts'
import type { Decision, Finding, Notification, Routine, TokenReport } from './projections/ops.ts'
import type { Peer, PeerCompactions, Session } from './projections/peers.ts'
import type { Work } from './projections/work.ts'
import type { ExternalItem } from './shapes.ts'
import type { WorkState } from './work-state.ts'

/** The three states a forge reports for a PR; `merged` is a `closed` one that merged. */
export const pullRequestStates = ['open', 'closed', 'merged'] as const
export type PullRequestState = (typeof pullRequestStates)[number]

/**
 * A `PullRequest` as the forge answered it: the projection's fields, plus the one
 * fact no projection holds.
 *
 * §3 has no `pr.closed`, so a `PullRequest` row — built from events — can say that
 * a PR merged and never that it is still open. The forge is the only thing that
 * knows, and it says so here rather than in the row.
 *
 * `state` is optional on purpose, and **undefined means unknown, never closed**: a
 * stored row carries no state at all, and an adapter that was told none has none to
 * report. A reader that treated absence as "done" would delete a person's checkout
 * on a forge's silence, which is the failure §9 exists to prevent.
 */
export interface ForgePullRequest extends PullRequest {
  readonly state?: PullRequestState
}

/**
 * The PR surface `gate`, `pr-babysit` and the `dedupe` rule need (§5.2, §10).
 * Implemented by `@fleet/integrations-github` over `gh` and git (phase 1).
 */
export interface PullRequests {
  /**
   * Open PRs for a repo; the gate and the retarget sweep walk these.
   *
   * **A list is a page, not a set.** Adapters cap it (`DEFAULT_LIMIT`), so a row's
   * *absence* says nothing at all: the PR may be open on page two. Only presence is
   * a fact, which is why a caller that needs "is this one open?" asks `get`.
   */
  list(repo: Repo, options?: { readonly state?: 'open' | 'closed' | 'all' }): Promise<readonly ForgePullRequest[]>

  /**
   * One PR, asked directly: `undefined` when the forge says it is not there, a
   * throw when the call itself failed — the two are deliberately different answers,
   * because "missing" is a fact and "unreachable" is not (§10, §9).
   */
  get(repo: Repo, number: number): Promise<ForgePullRequest | undefined>

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

  /**
   * Remote branches and the commits they point at, as the forge reports them. §6's
   * `branch-cleanup` sweep needs the list before it can tell a branch it may delete
   * from one that has commits the merge never saw, and nothing in the log says what
   * a remote currently holds.
   */
  branches(repo: Repo): Promise<readonly Branch[]>

  /**
   * The branch this repository treats as trunk, as it reports it — asked rather
   * than assumed. `main` and `master` are conventions, and a repo on `develop`,
   * `trunk` or `release/2.x` is the same fact under another name: a caller that
   * protects a hardcoded list protects the conventions and fails open on the rest.
   */
  defaultBranch(repo: Repo): Promise<string>

  /**
   * Delete a remote branch, pinned to the sha the caller decided on — the same rule
   * as `merge`, for the same reason. The forge is asked what the branch points at
   * now; that head must equal `expectedSha` or nothing is deleted and the call throws
   * a `FleetError` with code `head_moved`. A branch that is already gone is
   * `not_found`, not a silent success: the caller recorded an intent, and the log
   * should say the branch was not there.
   *
   * Deleting is a separate act from merging on purpose (§10): a merge that deletes
   * cannot be retried without it, and a dependent that appears between the two is a
   * branch someone still sits on.
   */
  deleteBranch(repo: Repo, branch: string, expectedSha: Sha): Promise<void>
}

/** A remote branch: its name and the commit it points at. */
export interface Branch {
  readonly name: string
  readonly sha: Sha
}

/**
 * An external tracker, as a source and a sink (§3): the board a fleet was asked
 * to mirror, never the state of the fleet itself. Implemented by
 * `@fleet/integrations-trackers-*` over the vendor's own CLI, and injected by
 * `apps/daemon`.
 *
 * The port speaks `WorkState`, not the tracker's statuses: the mapping from one
 * to the other is the *profile's* (`trackers.statuses`), handed to the adapter
 * when the daemon builds it. So a Jira board with its own columns needs no new
 * port, and a `transition` a profile said nothing about is a no-op the adapter
 * documents rather than a status invented here.
 */
export interface Tracker {
  /**
   * The tickets matching the profile's query. The query is opaque to the fleet —
   * each adapter documents its own dialect (Backlog.md: statuses, comma
   * separated; Jira: JQL) — and `tracker-sync` only ever passes the profile's
   * string through.
   */
  pull(query: string): Promise<readonly ExternalItem[]>

  /** One ticket, or `undefined` when the tracker says it does not exist. */
  get(key: string): Promise<ExternalItem | undefined>

  /**
   * Move the ticket to the status the profile maps `to` onto. A state the
   * profile does not map is left alone: the fleet has no opinion about the
   * tracker's vocabulary, and guessing one would rewrite a board nobody asked
   * it to touch.
   */
  transition(key: string, to: WorkState): Promise<void>

  /** Point the ticket at the PR that implements it (§10). Idempotent: the same URL twice adds nothing. */
  link(key: string, prUrl: string): Promise<void>
}

/**
 * A branch head, read from a checkout (§6.2's nightly scan). The fleet must name
 * the commit it is about to scan before it scans it, and no projection holds
 * that: the store records what the fleet *observed*, and nobody has observed
 * `main`'s head on a quiet night. So it is a port — implemented by
 * `@fleet/workspace-worktree` over `git` and injected by `apps/daemon` — and
 * `ReadModel` stays projections-only.
 */
export interface BranchHead {
  /**
   * The commit `origin/<branch>` points at in `cwd`, after asking the remote, or
   * `undefined` when the ref cannot be read (no such branch, not a repository,
   * `git` unreachable). An unknown head is a recorded skip, never a guess:
   * scanning a stale `origin/main` and calling it tonight's `main` would be the
   * one lie a security scan must not tell.
   */
  head(cwd: string, branch: string): Promise<Sha | undefined>
}

/**
 * §9's worktree manager, as much of it as `branch-cleanup` needs: removing the
 * checkout of a Work that has merged. Implemented by `@fleet/workspace-worktree`
 * over `git` and injected by `apps/daemon`.
 *
 * It is a port rather than a call the routine makes for itself because §9 makes
 * the manager the only thing that deletes a worktree; a second `git worktree
 * remove` in `orchestration` would be a second answer to "may this go".
 */
export interface Worktrees {
  /**
   * Remove the checkout at `path`, and nothing else: a path git does not know, or
   * one holding changes, throws instead of being forced. §9's rule — nothing is
   * deleted with local-only work — is enforced by git as well as by the caller.
   */
  remove(path: string): Promise<void>
}

/**
 * A file as a repository's default branch has it (§12.1): what a peer's standards
 * are read from, instead of a working tree the peer can edit — until a peer has a
 * worktree of its own, its cwd *is* the checkout, and a peer that could change its
 * own rules by editing `AGENTS.md` would be judged against what it wrote.
 */
export interface RepoFiles {
  /**
   * `path` at the tip of the default branch of the repository `cwd` belongs to,
   * and the commit it was read at. `undefined` when there is nothing to read:
   * `cwd` is not a repository, it has no default branch yet, or the file is not
   * on it. Never the working tree.
   */
  read(cwd: string, path: string): Promise<{ readonly text: string; readonly ref: string } | undefined>
}

/**
 * §9's creation half: make a checkout for a peer under the repo's own
 * `.claude/worktrees/<topic>`. Kept apart from `Worktrees` (removal) so a fake of
 * the one need not grow the other, and because the two have different callers:
 * the supervisor creates, `branch-cleanup` and `worktree-gc` remove.
 *
 * Idempotent, because a daemon restart asks again for a peer whose checkout is
 * already there.
 */
export interface WorktreeProvisioner {
  /**
   * A checkout of the repository at `root` at `<root>/.claude/worktrees/<topic>`,
   * on `branch` (created from `base` when it does not exist yet). `created` is
   * false when git already listed that path, so the caller can tell a reuse from
   * a new checkout. A branch another checkout holds, or a path git refuses, throws.
   */
  ensure(input: {
    readonly root: string
    readonly topic: string
    readonly branch: string
    /** Defaults to the remote's default branch, else `origin/main`, else `HEAD`. */
    readonly base?: string
  }): Promise<{ readonly path: string; readonly created: boolean }>
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
 * The build ledger's read side (§11). The ledger is unique on `(repo, sha,
 * task)`, so `find` is the whole dedupe: a build that already exists answers a
 * second request and nothing is appended.
 *
 * A port rather than a store import, for the §1.1 reason: `orchestration` may
 * not import `store`, and `apps/daemon` hands it `store.reader().builds`.
 */
export interface BuildReader {
  /** The build for a key, or `undefined` when the log has never seen it. */
  find(repo: Repo, sha: Sha, task: string): Promise<Build | undefined>
  /** One build by its id; what `build.finished` names and what a caller is handed back. */
  get(id: string): Promise<Build | undefined>
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
  /** §11's ledger, read back: `fleet build` reports what a deduped request found. */
  readonly builds: BuildReader
  readonly routines: {
    all(): Promise<readonly Routine[]>
  }
  /**
   * §17's two projections. There is no `all()`: a comparison names its runs, and
   * a read of every run with every case would grow with the log's history for a
   * caller that only ever asks about two of them.
   */
  readonly evals: {
    /** One run with its cases, or `undefined` if the log has no such run. */
    get(runId: EvalRunId): Promise<EvalRunWithCases | undefined>
  }
  /**
   * One row per peer that has ever compacted, and nothing for a peer that has
   * not — so a caller reads "never compacted" from the absence of a row rather
   * than from a zero it has to know to interpret (§8).
   */
  readonly compactions: {
    all(): Promise<readonly PeerCompactions[]>
  }
  /**
   * §6.2's cost report: a row per peer *and* Work, plus a rollup row per peer
   * with no `workId`. Asking for both in one read is what lets `fleet ls` print
   * a peer's bill and the board price each Work without two queries that could
   * disagree about a turn appended between them.
   */
  readonly tokens: {
    all(): Promise<readonly TokenReport[]>
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
