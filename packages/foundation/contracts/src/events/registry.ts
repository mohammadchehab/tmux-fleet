/**
 * The event registry (architecture §3). Every event type the fleet can write is
 * here, mapped to its schema; `FleetEvent` is the discriminated union derived
 * from it. A type that is not in this map cannot be appended, and a golden
 * fixture exists for each entry.
 */

import { union, type DistributiveOmit, type Infer, type Schema } from '@fleet/foundation-core'
import { peerFailed, peerRegistered, peerStateChanged, providerError, sessionEnded, sessionStarted } from './peer.ts'
import {
  workAssigned,
  workBlocked,
  workCancelled,
  workCleaned,
  workContractNeeded,
  workMergeable,
  workMerged,
  workProposed,
  workReady,
  workReviewRequested,
  workStarted,
} from './work.ts'
import {
  briefPublished,
  briefSuperseded,
  buildFinished,
  buildRequested,
  ciFailedFinal,
  contractPublished,
  prChecks,
  prMerged,
  prOpened,
  prRetargeted,
  prReview,
} from './delivery.ts'
import { messageAcked, messageDelivered, messageRejected, messageSent } from './messages.ts'
import {
  indexFailed,
  indexReady,
  purgeCompleted,
  purgeDegraded,
  purgeSaved,
  purgeStarted,
  routineFailed,
  routineFinished,
  routineStarted,
  worktreeClassified,
  worktreeCreated,
  worktreeRemoved,
} from './ops.ts'
import { decisionAnswered, decisionRequested } from './decisions.ts'
import {
  findingRaised,
  findingRouted,
  findingSeen,
  findingVerdicted,
  notifyFailed,
  notifySent,
  notifyWithdrawn,
  scanSkipped,
  standupRendered,
  turnUsage,
} from './signals.ts'

export const EVENT_SCHEMAS = {
  // peers and sessions (§3, §4, §7)
  'peer.registered': peerRegistered,
  'peer.state': peerStateChanged,
  'peer.failed': peerFailed,
  'session.started': sessionStarted,
  'session.ended': sessionEnded,
  'provider.error': providerError,

  // work (§5.1, §5.2)
  'work.proposed': workProposed,
  'work.contract_needed': workContractNeeded,
  'work.ready': workReady,
  'work.assigned': workAssigned,
  'work.started': workStarted,
  'work.review_requested': workReviewRequested,
  'work.mergeable': workMergeable,
  'work.merged': workMerged,
  'work.cleaned': workCleaned,
  'work.blocked': workBlocked,
  'work.cancelled': workCancelled,

  // contracts, briefs, PRs, builds (§10, §11, §12)
  'contract.published': contractPublished,
  'brief.published': briefPublished,
  'brief.superseded': briefSuperseded,
  'pr.opened': prOpened,
  'pr.checks': prChecks,
  'pr.review': prReview,
  'pr.merged': prMerged,
  'pr.retargeted': prRetargeted,
  'ci.failed_final': ciFailedFinal,
  'build.requested': buildRequested,
  'build.finished': buildFinished,

  // the mailbox (§7)
  'message.sent': messageSent,
  'message.delivered': messageDelivered,
  'message.acked': messageAcked,
  'message.rejected': messageRejected,

  // routines, worktrees, purge, index (§6, §8, §9, §6.2)
  'routine.started': routineStarted,
  'routine.finished': routineFinished,
  'routine.failed': routineFailed,
  'worktree.created': worktreeCreated,
  'worktree.classified': worktreeClassified,
  'worktree.removed': worktreeRemoved,
  'purge.started': purgeStarted,
  'purge.saved': purgeSaved,
  'purge.degraded': purgeDegraded,
  'purge.completed': purgeCompleted,
  'index.ready': indexReady,
  'index.failed': indexFailed,

  // decisions (§5.3, §5.4)
  'decision.requested': decisionRequested,
  'decision.answered': decisionAnswered,

  // signals (§6, §6.1, §6.2)
  'notify.sent': notifySent,
  'notify.failed': notifyFailed,
  'notify.withdrawn': notifyWithdrawn,
  'standup.rendered': standupRendered,
  'scan.skipped': scanSkipped,
  'finding.raised': findingRaised,
  'finding.seen': findingSeen,
  'finding.verdict': findingVerdicted,
  'finding.routed': findingRouted,
  'turn.usage': turnUsage,
} as const

export type FleetEventType = keyof typeof EVENT_SCHEMAS

/** The whole fleet's event vocabulary as one discriminated union. */
export type FleetEvent = Infer<(typeof EVENT_SCHEMAS)[FleetEventType]>

/** An event to append: a `FleetEvent` before the store assigns its seq. */
export type AppendEvent = DistributiveOmit<FleetEvent, 'seq'>

/** One event type's full envelope, by type name. */
export type FleetEventOf<T extends FleetEventType> = Infer<(typeof EVENT_SCHEMAS)[T]>

/** The schema for one event type, or `undefined` if the type is not registered. */
export const eventSchemaFor = (type: string): Schema<FleetEvent> | undefined =>
  Object.hasOwn(EVENT_SCHEMAS, type)
    ? (EVENT_SCHEMAS[type as FleetEventType] as unknown as Schema<FleetEvent>)
    : undefined

/** The union schema; what the store parses an event row with. */
export const fleetEvent = (): Schema<FleetEvent> =>
  union(Object.values(EVENT_SCHEMAS) as readonly Schema<unknown>[]) as Schema<FleetEvent>

export const eventTypes = Object.keys(EVENT_SCHEMAS) as readonly FleetEventType[]
