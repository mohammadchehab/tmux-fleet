/**
 * One `ls` and its parts, as the daemon sends them — the smallest faithful
 * version of the answer, so a test can say "a waiting peer and one open
 * decision" and see the rows that follow.
 */

import type {
  DaemonStatus,
  Decision,
  LsResult,
  Peer,
  PeerActivity,
  PeerCompactions,
  TokenReport,
} from '@fleet/foundation-contracts'
import type { DecisionId, PeerId, PeerState } from '@fleet/foundation-core'

const at = '2026-01-01T00:00:00.000Z'

export const peerOf = (id: string, state: PeerState = 'idle'): Peer => ({
  peerId: id as PeerId,
  role: 'engineer',
  providerId: 'claude',
  model: 'claude-opus-5-5',
  permissionMode: 'bypassPermissions',
  briefVersion: 1,
  state,
  registeredAt: at,
  updatedAt: at,
})

export const decisionOf = (id: string, question = 'Ship it?', options = ['Yes', 'No']): Decision => ({
  decisionId: id as DecisionId,
  kind: 'approval',
  state: 'open',
  question,
  options,
  inputsHash: 'abcdef012345',
  requestedAt: at,
})

export const tokensOf = (id: string, turns: number, costUsd = 0): TokenReport => ({
  peerId: id as PeerId,
  role: 'engineer',
  turns,
  inputTokens: 1000 * turns,
  outputTokens: 100 * turns,
  cachedTokens: 0,
  costUsd,
  toolCalls: { grep: 0, glob: 0, read: 0, codegraph: 0 },
  redirects: 0,
  updatedAt: at,
})

export const activityOf = (id: string, lastTool?: string, lastTarget?: string): PeerActivity => ({
  peerId: id as PeerId,
  ...(lastTool === undefined ? {} : { lastTool }),
  ...(lastTarget === undefined ? {} : { lastTarget }),
  edits: 0,
})

export const compactionsOf = (id: string, count = 1): PeerCompactions => ({
  peerId: id as PeerId,
  count,
  lastAt: at,
  lastTrigger: 'auto',
  lastPreTokens: 100_000,
})

export const statusOf = (profile = 'tmux-fleet', socketPath = '/home/tester/.fleet/tmux-fleet/daemon/fleetd.sock'): DaemonStatus => ({
  profile,
  pid: 4242,
  startedAt: at,
  socketPath,
  storePath: '/home/tester/.fleet/tmux-fleet/store.db',
})

export interface LsParts {
  readonly profile?: string
  readonly socketPath?: string
  readonly peers?: readonly Peer[]
  readonly decisions?: readonly Decision[]
  readonly tokens?: readonly TokenReport[]
  readonly activity?: readonly PeerActivity[]
  readonly compactions?: readonly PeerCompactions[]
}

export const lsOf = (parts: LsParts = {}): LsResult => ({
  status: statusOf(parts.profile, parts.socketPath),
  peers: parts.peers ?? [],
  routines: [],
  decisions: parts.decisions ?? [],
  compactions: parts.compactions ?? [],
  tokens: parts.tokens ?? [],
  activity: parts.activity ?? [],
})
