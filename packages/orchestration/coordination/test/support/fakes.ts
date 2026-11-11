/**
 * An in-memory `Coordination` with the port's semantics — leases, create-once,
 * a read that answers the ref's current commit — so the publisher and reader are
 * tested against the contract rather than against git. That the git transport
 * keeps the same contract is `@fleet/integrations-coordination`'s own suite.
 */

import { fleetError, type Clock, type PeerId, type Sha, type Timestamp } from '@fleet/foundation-core'
import type { Coordination, CoordinationFiles, MonthSpend, Peer, ReadModel } from '@fleet/foundation-contracts'

export interface FakeCoordination extends Coordination {
  /** Every publish that landed, in order. */
  readonly pushes: { readonly ref: string; readonly files: CoordinationFiles }[]
  /** Write a ref as some other machine would, bypassing every lease. */
  force(ref: string, files: CoordinationFiles): Sha
}

export const fakeCoordination = (): FakeCoordination => {
  const refs = new Map<string, { readonly sha: Sha; readonly files: CoordinationFiles }>()
  const pushes: { ref: string; files: CoordinationFiles }[] = []
  let next = 0
  const commit = (ref: string, files: CoordinationFiles): Sha => {
    const sha = (++next).toString(16).padStart(40, '0') as Sha
    refs.set(ref, { sha, files: { ...files } })
    return sha
  }

  return {
    pushes,
    force: commit,
    async refs(prefix) {
      return [...refs]
        .filter(([name]) => prefix === undefined || name.startsWith(prefix))
        .map(([name, held]) => ({ name, sha: held.sha }))
    },
    async read(ref) {
      const held = refs.get(ref.name)
      return held === undefined ? undefined : { sha: held.sha, files: held.files }
    },
    async publish({ ref, files, expected }) {
      const now = refs.get(ref)?.sha
      if (now !== expected) throw fleetError('head_moved', `${ref} is at ${now ?? 'nothing'}`)
      pushes.push({ ref, files })
      return commit(ref, files)
    },
    async create({ ref, files }) {
      const held = refs.get(ref)
      if (held !== undefined) return { created: false, sha: held.sha }
      return { created: true, sha: commit(ref, files) }
    },
    async release(ref, expected) {
      const held = refs.get(ref)
      if (held === undefined) throw fleetError('not_found', `${ref} is gone`)
      if (held.sha !== expected) throw fleetError('head_moved', `${ref} moved`)
      refs.delete(ref)
    },
  }
}

/** A clock the test moves by hand. */
export const manualClock = (start: string) => {
  let at = Date.parse(start)
  const clock: Clock = {
    now: () => new Date(at).toISOString() as Timestamp,
    millis: () => at,
  }
  return {
    clock,
    advance: (ms: number) => {
      at += ms
    },
  }
}

export const peerRow = (peerId: string, role: string, state: Peer['state']): Peer => ({
  peerId: peerId as PeerId,
  role,
  providerId: 'claude-code' as Peer['providerId'],
  model: 'claude-sonnet-5-5',
  permissionMode: 'acceptEdits',
  briefVersion: 1,
  state,
  registeredAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
})

/** The two reads the publisher makes, answering from values the test sets. */
export const fakeRead = (initial: { spentUsd?: number; peers?: readonly Peer[] } = {}) => {
  const state = { spentUsd: initial.spentUsd ?? 0, unpricedTurns: 0, peers: initial.peers ?? [] }
  const read: Pick<ReadModel, 'tokens' | 'peers'> = {
    tokens: {
      all: async () => [],
      month: async (month): Promise<MonthSpend> => ({
        month,
        costUsd: state.spentUsd,
        turns: state.spentUsd > 0 ? 1 : 0,
        unpricedTurns: state.unpricedTurns,
      }),
    },
    peers: {
      all: async () => state.peers,
      get: async (id) => state.peers.find((peer) => peer.peerId === id),
    },
  }
  return { read, state }
}
