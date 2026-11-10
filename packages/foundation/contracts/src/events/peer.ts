/**
 * Peer and session lifecycle (architecture §3, §4, §7, §8). `peerId` is the
 * subject of `peer.*`; `sessionId` is the subject of `session.*`. A peer
 * outlives its sessions, and nothing outside the registry sees a session ref.
 */

import {
  array,
  boolean,
  count,
  event,
  number,
  object,
  objectAs,
  oneOf,
  optional,
  refine,
  string,
  text,
  type PeerId,
  type Schema,
  type SessionId,
} from '@fleet/foundation-core'
import { briefId, peerId, positiveInt, providerSessionRef, sessionId, worktreeId } from '@fleet/foundation-core'
import { contentHash } from '../shapes.ts'
import { peerState } from '@fleet/foundation-core'
import { compactionTriggers, effort, permissionMode, providerId } from '../provider.ts'

/** A peer exists. Written once per peer, from the profile's squad (§6, §1.1 config). */
export const peerRegistered = event(
  'peer.registered',
  object({
    peerId: peerId(),
    role: string({ minLength: 1, maxLength: 80 }),
    providerId: providerId(),
    model: string({ minLength: 1 }),
    permissionMode: permissionMode(),
    worktreeId: optional(worktreeId()),
  }),
)

/**
 * A peer's standing brief changed (§12.1): the standards it works under — the
 * repo's own `AGENTS.md`/`CLAUDE.md`, the profile's non-negotiables, the skill
 * documents its role needs — were read and are not what the peer last carried.
 *
 * Written **only when `digest` differs** from the peer's last one, before the
 * session that will carry it starts, so the store and the session agree on what
 * the peer was told. `version` goes up (the same per-peer counter a Work's
 * `brief.published` moves, so a later `assign` must exceed it) and the projection
 * sets `peer.briefVersion` from it; the Mailbox's staleness check (§7) reads that.
 *
 * Standards are read from the filesystem, which is not deterministic; this event
 * is what makes them so. The bytes live in a content-addressed file named by
 * `digest` (a cache and an archive, never the truth), and `sources` records what
 * was read: how many characters, whether it was cut, and the commit it came from
 * — so a peer's rules can be audited, and a replay does not re-read a disk — and
 * `skipped` what it was meant to read and could not.
 *
 * Not `brief.published`: that is a Work's brief and carries a `workId`, and a
 * standing brief belongs to a peer, not a Work.
 */
export const peerStandardsSet = event(
  'peer.standards_set',
  object({
    peerId: peerId(),
    version: positiveInt(),
    briefId: briefId(),
    /** sha-256 of what the peer is handed — its brief text and its standards — so a changed role is a changed brief too. */
    digest: contentHash(),
    sources: array(
      object({
        /** How the peer is told where it came from: `AGENTS.md`, `Non-negotiables (…)`, `skill:…`. */
        name: text(300),
        chars: count(),
        truncated: boolean(),
        /** The commit it was read at, when it came from git; absent for a profile-owned file. */
        ref: optional(string({ minLength: 1, maxLength: 100 })),
      }),
      { maxItems: 40 },
    ),
    /**
     * What the peer was *meant* to carry and does not: a repo with no default
     * branch to read `AGENTS.md` from, a file that is not on it. Recorded so the
     * board can say "no repo standards loaded" instead of a peer quietly working
     * without them.
     */
    skipped: array(object({ name: text(300), reason: text(300) }), { maxItems: 40 }),
  }),
)

/**
 * The peer's state changed (§4). This is the event behind the board, the PM's
 * `assign`/`unblock` rules and the supervisor's reconcile: never a scraped
 * pane.
 */
export const peerStateChanged = event(
  'peer.state_changed',
  object({
    peerId: peerId(),
    state: peerState(),
    sessionId: optional(sessionId()),
    /** Why the provider said so, for a state a reader will question later. */
    reason: optional(text(500)),
  }),
)

/**
 * Why a peer failed. A closed set, so the notification class is a switch and
 * not a match on prose; `message` carries the sentence a human reads (§6.1).
 */
export const peerFailureReasons = ['config_mismatch', 'session_died', 'resume_failed', 'provider_error'] as const
export type PeerFailureReason = (typeof peerFailureReasons)[number]

/**
 * What the supervisor saw a session running. `model` is always observable;
 * `baseUrl` only when the adapter recorded what it set, because no SDK exposes
 * the endpoint it dialled (§4, §13).
 */
export interface SessionFacts {
  readonly model: string
  readonly baseUrl?: string
}

const sessionFacts = (): Schema<SessionFacts> =>
  objectAs<SessionFacts>()({ model: string({ minLength: 1 }), baseUrl: optional(string({ minLength: 1 })) })

export interface PeerFailedData {
  readonly peerId: PeerId
  readonly sessionId?: SessionId
  readonly reason: PeerFailureReason
  /** The human sentence: an exit code, the SDK's message, what was denied. */
  readonly message?: string
  /** Present with `config_mismatch`: what the `SessionSpec` asked for. */
  readonly expected?: SessionFacts
  /** Present with `config_mismatch`: what came up instead. */
  readonly observed?: SessionFacts
  readonly retryable: boolean
}

/** A peer's session died or would not resume: a failure notification class (§6.1). */
export const peerFailed = event(
  'peer.failed',
  refine(
    objectAs<PeerFailedData>()({
      peerId: peerId(),
      sessionId: optional(sessionId()),
      reason: oneOf(peerFailureReasons),
      message: optional(text(1000)),
      expected: optional(sessionFacts()),
      observed: optional(sessionFacts()),
      retryable: boolean(),
    }),
    // A mismatch with nothing to compare is not a diagnosis: the two facts are
    // what makes the event worth storing (§4, §13).
    (value) => value.reason !== 'config_mismatch' || (value.expected !== undefined && value.observed !== undefined),
    'expected and observed when the reason is config_mismatch',
  ),
)

/**
 * One tool call inside a peer's turn (§4). `Peer.state` says a peer is
 * `working`; it cannot say at what, and a person watching `fleet ls` had to
 * guess from a mailbox that only ever showed what was sent to it.
 *
 * Both fields are the provider's own `tool.use` event's: `tool` is the
 * adapter's name for the tool, `target` its short, already-redacted summary —
 * a file path, a description, a command — never the tool's input. A provider
 * that does not summarise (cursor) contributes the name alone, which is the
 * honest answer rather than a target this fleet inferred.
 */
export const peerToolUsed = event(
  'peer.tool_used',
  object({
    peerId: peerId(),
    sessionId: optional(sessionId()),
    tool: string({ minLength: 1, maxLength: 64 }),
    /** The adapter's short target, bounded again so one log row stays small. */
    target: optional(string({ minLength: 1, maxLength: 200 })),
  }),
)

/**
 * A provider compacted a peer's context on its own or on a person's say-so (§8).
 *
 * Recorded because a compaction is money: the conversation is re-sent to a
 * summarizer, and the peer comes back with less of what it knew. It is not a
 * failure — the session carries on — so it is its own event rather than a
 * `peer.failed`, and it is written for compactions that happened *between*
 * turns, which is where they mostly happen.
 */
export const peerCompacted = event(
  'peer.compacted',
  object({
    peerId: peerId(),
    trigger: oneOf(compactionTriggers),
    /** Context tokens the provider compacted: the number that sizes the bill. */
    preTokens: count(),
    /** What the context held afterwards; absent when the provider did not say. */
    postTokens: optional(count()),
    /**
     * The context window this peer was configured with, next to the tokens it
     * actually compacted at (§8). The pair is the point: a compaction at 40K
     * under a limit of 200K says the configured limit is wrong for the model, and
     * no purge ratio will ever fire in time on a number that size. Absent when
     * the provider does not report usage, because then there is no limit to
     * compare against.
     */
    contextLimit: optional(count()),
    /**
     * What the re-send cost at the model's configured price, when one is
     * configured. Absent means "not priced here", never "free" (§11).
     */
    estimatedCostUsd: optional(number({ min: 0 })),
  }),
)

/**
 * A session came up. `resumed` is true when it continued a `ProviderSessionRef`.
 * `model`, `permissionMode` and `endpoint` are what the session is *running*,
 * read from its first init and the adapter's own record, never echoed from the
 * request: a spec can be wrong and a leaked environment can silently change the
 * endpoint (§4, §13). `endpoint` is present only when the adapter recorded the
 * base URL it set, since an SDK does not expose it.
 */
export const sessionStarted = event(
  'session.started',
  object({
    peerId: peerId(),
    sessionId: sessionId(),
    providerId: providerId(),
    providerSessionRef: providerSessionRef(),
    model: string({ minLength: 1 }),
    /**
     * The reasoning level the session was asked to start on (TASK-12). It is a
     * *requested* value, like `model`: absent means the profile asked for none,
     * not that the provider had no opinion. Whether the provider could honour it
     * is `fleet up`'s warning, recorded there rather than in this event.
     */
    effort: optional(effort()),
    permissionMode: permissionMode(),
    endpoint: optional(string({ minLength: 1, maxLength: 500 })),
    resumed: boolean(),
  }),
)

/** Why a session ended; `purged` is the self-purge restart (§8), not a failure. */
export const sessionEndReasons = ['stopped', 'purged', 'crashed', 'restarted', 'completed', 'failed'] as const
export type SessionEndReason = (typeof sessionEndReasons)[number]

export const sessionEnded = event(
  'session.ended',
  object({
    peerId: peerId(),
    sessionId: sessionId(),
    endReason: oneOf(sessionEndReasons),
    /**
     * The provider process's exit code, when the provider runs one: kept on the
     * stored event so a replay can still tell `exit 1` from `exit 0` (§4, §7).
     * Absent for an in-process provider, and for a session we stopped.
     */
    code: optional(number({ int: true })),
  }),
)

/**
 * A provider reported an error it did not recover from by itself: a failure
 * notification class, deduped and rate-limited by key (§6.1).
 */
export const providerError = event(
  'provider.errored',
  object({
    peerId: peerId(),
    sessionId: optional(sessionId()),
    providerId: providerId(),
    code: string({ minLength: 1, maxLength: 80 }),
    message: text(2000),
    retryable: boolean(),
  }),
)
