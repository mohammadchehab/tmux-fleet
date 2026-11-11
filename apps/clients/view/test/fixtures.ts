/**
 * One valid `ls` answer, for tests that are about rendering and not about the
 * daemon. Values are literal and spelled the way the contract spells them, so a
 * field renamed in `@fleet/foundation-contracts` fails the type check here
 * rather than silently rendering `undefined` in a pane.
 */

import type { LsResult, Peer, PeerActivity } from '@fleet/foundation-contracts'
import type { PeerId, SessionId, WorkId } from '@fleet/foundation-core'

/**
 * A peer row. The id is taken as a plain string and branded here, so a test reads
 * `peerFixture({ peerId: 'engineer-1' })` rather than `'engineer-1' as PeerId`
 * on every line.
 */
export const peerFixture = (overrides: Partial<Omit<Peer, 'peerId'>> & { readonly peerId: string }): Peer => {
  const { peerId: raw, ...rest } = overrides
  return {
    peerId: raw as PeerId,
    role: 'engineer',
    providerId: 'claude',
    model: 'opus',
    permissionMode: 'acceptEdits',
    briefVersion: 3,
    state: 'working',
    registeredAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T12:59:55.123Z',
    ...rest,
  }
}

/**
 * A peer-activity row: what the peer is working on, the last tool and its short
 * target, the edits that Work has taken, and when its last turn ended. All four
 * are projection values; no pane infers any of them from the peer's state.
 */
export const activityFixture = (
  overrides: Partial<Omit<PeerActivity, 'peerId'>> & { readonly peerId?: string } = {},
): PeerActivity => {
  const { peerId: raw, ...rest } = overrides
  return {
    peerId: (raw ?? 'engineer-1') as PeerId,
    workId: 'wrk_0123456789abcdef' as WorkId,
    lastTool: 'Edit',
    lastTarget: 'packages/foundation/store/src/peers.ts',
    lastToolAt: '2026-11-10T12:58:01.000Z',
    lastTurnAt: '2026-11-10T12:58:01.000Z',
    edits: 14,
    ...rest,
  }
}

export const lsFixture = (peers: readonly Peer[]): LsResult => ({
  status: {
    profile: 'firstrun',
    pid: 4242,
    startedAt: '2026-11-10T08:00:00.000Z',
    socketPath: '/home/someone/.fleet/firstrun/daemon/fleetd.sock',
    storePath: '/home/someone/.fleet/firstrun/store.db', protocolVersion: 1,
  },
  peers,
  routines: [],
  decisions: [],
  compactions: [],
  tokens: [],
  activity: [],
})

/** An opaque id is `<prefix>_<16 lowercase hex>`, which is what `sessionId()` checks. */
export const SESSION = 'ses_0123456789abcdef' as SessionId
