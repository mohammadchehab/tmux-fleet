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
  worktreeId,
} from '@fleet/foundation-core'
import { compactionTriggers, permissionMode, providerId } from '../provider.ts'
import type { PeerState } from '@fleet/foundation-core'
import type { PeerId, SessionId, ProviderSessionRef, WorktreeId } from '@fleet/foundation-core'
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
