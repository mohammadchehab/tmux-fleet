/**
 * One valid `ls` answer, for tests that are about rendering and not about the
 * daemon. Values are literal and spelled the way the contract spells them, so a
 * field renamed in `@fleet/foundation-contracts` fails the type check here
 * rather than silently rendering `undefined` in a pane.
 */

import type { LsResult, Peer } from '@fleet/foundation-contracts'
import type { PeerId, SessionId } from '@fleet/foundation-core'

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

export const lsFixture = (peers: readonly Peer[]): LsResult => ({
  status: {
    profile: 'firstrun',
    pid: 4242,
    startedAt: '2026-11-10T08:00:00.000Z',
    socketPath: '/home/someone/.fleet/firstrun/daemon/fleetd.sock',
    storePath: '/home/someone/.fleet/firstrun/store.db',
  },
  peers,
  routines: [],
  decisions: [],
  compactions: [],
})

/** An opaque id is `<prefix>_<16 lowercase hex>`, which is what `sessionId()` checks. */
export const SESSION = 'ses_0123456789abcdef' as SessionId
