/**
 * Stating a fleet instead of arranging one (architecture §5.2: "a test states the fleet it wants").
 *
 * Each builder takes a partial row and fills the rest, so a test says only what it is about: the Work's state, the
 * PR's review, the peer's role. Nothing here opens a store — a rule is a pure function of the snapshot, so the test
 * of a rule is a value, not a fixture on disk.
 */

import type {
  Decision,
  FleetState,
  Message,
  Notification,
  Peer,
  PullRequest,
  PullRequestRef,
  Work,
} from '@fleet/foundation-contracts'
import type { DecisionId, MessageId, NotificationKey, PeerId, Sha, WorkId } from '@fleet/foundation-core'
import type { PmTick, RoutineKind, RoutineTrigger } from '@fleet/foundation-contracts'

/** The instant everything in a test happens at unless it says otherwise. */
export const T0 = '2026-11-10T09:00:00.000Z'

export const peer = (over: Partial<Peer> = {}): Peer => ({
  peerId: 'engineer-1' as PeerId,
  role: 'engineer',
  providerId: 'claude',
  model: 'claude-sonnet-5-5',
  permissionMode: 'acceptEdits',
  briefVersion: 0,
  state: 'idle',
  registeredAt: T0,
  updatedAt: T0,
  ...over,
})

export const architect = (over: Partial<Peer> = {}): Peer =>
  peer({ peerId: 'architect-1' as PeerId, role: 'pr-architect', ...over })

export const work = (over: Partial<Work> = {}): Work => ({
  workId: 'wrk_0000000000000001' as WorkId,
  title: 'Ship the store',
  state: 'ready',
  dependsOn: [],
  prs: [],
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

export const pullRequest = (over: Partial<PullRequest> = {}): PullRequest => ({
  repo: 'backbase/fleet' as PullRequest['repo'],
  number: 38,
  base: 'main',
  head: 'feature/store',
  headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' as Sha,
  checks: 'passing',
  failingChecks: [],
  review: 'approved',
  merged: false,
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

export const refOf = (pr: PullRequest): PullRequestRef => ({ repo: pr.repo, number: pr.number })

export const decision = (over: Partial<Decision> = {}): Decision => ({
  decisionId: 'dec_0000000000000001' as DecisionId,
  kind: 'approval',
  state: 'open',
  question: 'Merge it?',
  options: ['merge', 'hold'],
  inputsHash: '0123456789abcdef',
  requestedAt: T0,
  ...over,
})

export const message = (over: Partial<Message> = {}): Message => ({
  msgId: 'msg_0000000000000001' as MessageId,
  to: 'engineer-1' as PeerId,
  from: 'pm',
  kind: 'answer',
  briefVersion: 1,
  body: 'What the PM said',
  state: 'acked',
  sentAt: T0,
  ...over,
})

export const notification = (over: Partial<Notification> = {}): Notification => ({
  key: 'standup:2026-11-10' as NotificationKey,
  class: 'standup',
  state: 'pending',
  deliveryFailed: false,
  occurrences: 1,
  createdAt: T0,
  ...over,
})

export const state = (over: Partial<FleetState> = {}): FleetState => ({
  peers: [],
  sessions: [],
  work: [],
  decisions: [],
  messages: [],
  pullRequests: [],
  worktrees: [],
  routines: [],
  findings: [],
  notifications: [],
  ...over,
})

export const tick = (
  over: Partial<PmTick> & { kind?: RoutineKind; trigger?: RoutineTrigger } = {},
): PmTick => ({
  at: T0,
  routineId: 'dispatch-1',
  kind: 'dispatch',
  trigger: 'heartbeat',
  ...over,
})

/** The action kinds, in order: what a test asserts when it is about the shape of a tick rather than its detail. */
export const kinds = (actions: readonly { kind: string }[]): readonly string[] => actions.map((action) => action.kind)
