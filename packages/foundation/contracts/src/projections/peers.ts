/**
 * `Peer` and `Session` projections (architecture §3, §7). A peer is the stable
 * identity; sessions come and go beneath it, and only the registry ever sees a
 * session ref.
 */

import { boolean, count, object, objectAs, oneOf, optional, string, type Schema } from '@fleet/foundation-core'
import {
  peerId,
  peerState,
  providerSessionRef,
  sessionId,
  timestamp,
  workId,
  worktreeId,
} from '@fleet/foundation-core'
import { compactionTriggers, permissionMode, providerId } from '../provider.ts'
import type { PeerState } from '@fleet/foundation-core'
import type { PeerId, SessionId, ProviderSessionRef, WorkId, WorktreeId } from '@fleet/foundation-core'
import type { CompactionTrigger, PermissionMode } from '../provider.ts'

export interface Peer {
  readonly peerId: PeerId
  readonly role: string
  readonly providerId: string
  readonly model: string
  readonly permissionMode: PermissionMode
  readonly worktreeId?: WorktreeId
  /** The live session, if any; `undefined` after an end and before a resume. */
  readonly currentSessionId?: SessionId
  /** The brief version the peer's context currently carries (§7, §12). */
  readonly briefVersion: number
  readonly state: PeerState
  readonly registeredAt: string
  readonly updatedAt: string
}

export const peer = (): Schema<Peer> =>
  objectAs<Peer>()({
    peerId: peerId(),
    role: string({ minLength: 1, maxLength: 80 }),
    providerId: providerId(),
    model: string({ minLength: 1 }),
    permissionMode: permissionMode(),
    worktreeId: optional(worktreeId()),
    currentSessionId: optional(sessionId()),
    briefVersion: count(),
    state: peerState(),
    registeredAt: timestamp(),
    updatedAt: timestamp(),
  })

/**
 * One peer's compactions, as `ls` shows them (§8): how often this peer has lost
 * its context, when it last did, and what the last one dropped. A peer whose
 * count is climbing is a peer whose sessions are too long or whose purge
 * threshold is too generous — which is the point of showing it.
 */
export interface PeerCompactions {
  readonly peerId: PeerId
  readonly count: number
  readonly lastAt: string
  readonly lastTrigger: CompactionTrigger
  readonly lastPreTokens: number
}

export const peerCompactions = (): Schema<PeerCompactions> =>
  objectAs<PeerCompactions>()({
    peerId: peerId(),
    count: count(),
    lastAt: timestamp(),
    lastTrigger: oneOf(compactionTriggers),
    lastPreTokens: count(),
  })

/**
 * What a peer is doing right now (§4). `Peer.state` can say `working`; it
 * cannot say *at what*, and a person watching `fleet ls` had only the mailbox
 * to guess from. This is the missing half, and it is a projection like any
 * other: derived from `peer.tool_used` and `turn.usage_recorded`, so a replay
 * shows the same activity the live fleet did.
 *
 * One row per peer with something to say — a current Work, a tool call, or a
 * finished turn. A peer that has none of those has no row, the same way a peer
 * that never compacted has no compaction row.
 */
export interface PeerActivity {
  readonly peerId: PeerId
  /** The Work the peer is on: assigned, and not yet cleaned or cancelled. */
  readonly workId?: WorkId
  /** The provider's name for the last tool it ran. */
  readonly lastTool?: string
  /** That call's short, already-redacted target — a path, a description, a command. */
  readonly lastTarget?: string
  readonly lastToolAt?: string
  /**
   * When the peer's last turn ended, as far as the fleet could account for it.
   * Absent for a provider that reports no spend, which is the same "not known
   * here" the compaction cost uses rather than a zero that would read as a time.
   */
  readonly lastTurnAt?: string
  /**
   * Edit and Write calls this peer has made on `workId`: how much it is
   * rewriting, which is the number that says a peer is thrashing. Reads and
   * searches are deliberately not counted — they are the turn working, not the
   * Work being reworked (§6.2 counts those separately).
   */
  readonly edits: number
}

export const peerActivity = (): Schema<PeerActivity> =>
  objectAs<PeerActivity>()({
    peerId: peerId(),
    workId: optional(workId()),
    lastTool: optional(string({ minLength: 1, maxLength: 64 })),
    lastTarget: optional(string({ minLength: 1, maxLength: 200 })),
    lastToolAt: optional(timestamp()),
    lastTurnAt: optional(timestamp()),
    edits: count(),
  })

export interface Session {
  readonly sessionId: SessionId
  readonly peerId: PeerId
  readonly providerId: string
  readonly providerSessionRef: ProviderSessionRef
  readonly model: string
  readonly permissionMode: PermissionMode
  readonly resumed: boolean
  readonly startedAt: string
  readonly endedAt?: string
  readonly endReason?: string
}

export const session = (): Schema<Session> =>
  objectAs<Session>()({
    sessionId: sessionId(),
    peerId: peerId(),
    providerId: providerId(),
    providerSessionRef: providerSessionRef(),
    model: string({ minLength: 1 }),
    permissionMode: permissionMode(),
    resumed: boolean(),
    startedAt: timestamp(),
    endedAt: optional(timestamp()),
    endReason: optional(string({ minLength: 1, maxLength: 40 })),
  })
