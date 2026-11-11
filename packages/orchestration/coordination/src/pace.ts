/**
 * The arithmetic of a fleet's pace (shared-fleet.md §3), kept pure so the rule
 * that decides who bids is a function of numbers a test can write down.
 */

import { fleetError, isAssignable, type Timestamp } from '@fleet/foundation-core'
import type { FleetPace, IdleCapacity, MonthSpend, Peer } from '@fleet/foundation-contracts'

const HOUR_MS = 3_600_000

/** `YYYY-MM` of an instant, in UTC: the month a cap is kept in. */
export const monthOf = (at: Timestamp | string): string => new Date(at).toISOString().slice(0, 7)

/** How much of `at`'s UTC month has gone, from 0 to 1. */
export const elapsedShare = (at: Timestamp | string): number => {
  const now = new Date(at)
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  return (now.getTime() - start) / (end - start)
}

/**
 * `spent / cap` against the share of the month gone. The share is floored at an
 * hour, so the first minutes of a month — when a single turn is an enormous
 * fraction of nothing — read as far over pace rather than as infinity, which no
 * reader could compare. A cap of zero has no pace: a fleet that declared no
 * budget publishes nothing (the publisher refuses it), so this refuses it too.
 */
export const paceOf = (input: { readonly capUsd: number; readonly spentUsd: number; readonly at: Timestamp | string }): number => {
  if (!(input.capUsd > 0)) throw fleetError('invalid_input', `a pace needs a positive monthly cap, got ${String(input.capUsd)}`)
  const now = new Date(input.at)
  const monthMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const share = Math.max(elapsedShare(input.at), HOUR_MS / monthMs)
  return round(input.spentUsd / input.capUsd / share, 3)
}

/** Idle, live peers by role, sorted so two equal fleets publish equal bytes. */
export const capacityOf = (peers: readonly Peer[]): readonly IdleCapacity[] => {
  const idle = new Map<string, number>()
  for (const peer of peers) if (isAssignable(peer.state)) idle.set(peer.role, (idle.get(peer.role) ?? 0) + 1)
  return [...idle].sort(([a], [b]) => (a < b ? -1 : 1)).map(([role, count]) => ({ role, idle: count }))
}

export const fleetPaceOf = (input: {
  readonly capUsd: number
  readonly spend: MonthSpend
  readonly peers: readonly Peer[]
  readonly at: Timestamp
}): FleetPace => ({
  version: 1,
  month: input.spend.month,
  capUsd: input.capUsd,
  spentUsd: round(input.spend.costUsd, 2),
  unpricedTurns: input.spend.unpricedTurns,
  pace: paceOf({ capUsd: input.capUsd, spentUsd: input.spend.costUsd, at: input.at }),
  capacity: capacityOf(input.peers),
  heartbeat: input.at,
})

/**
 * Whether two documents differ in anything but the clock. `pace` and `heartbeat`
 * move every second on their own; the facts under them — the month, the cap,
 * the spend to the cent, the idle peers — are what a reader would act on.
 */
export const sameFacts = (a: FleetPace, b: FleetPace): boolean =>
  a.month === b.month &&
  a.capUsd === b.capUsd &&
  a.spentUsd === b.spentUsd &&
  a.unpricedTurns === b.unpricedTurns &&
  JSON.stringify(a.capacity) === JSON.stringify(b.capacity)

const round = (value: number, places: number): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
