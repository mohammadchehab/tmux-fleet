/**
 * Reading the other fleets' pace (shared-fleet.md §2.2, §3). One `refs` call
 * finds every fleet branch in the engagement; each is read through the port,
 * which fetches only what moved since the last poll.
 *
 * Every document is someone else's bytes. It is decoded strictly against the
 * schema, and one that does not decode is reported with what was wrong — never
 * thrown, because one fleet on a newer build or a broken laptop must not blind
 * this one to the rest of the pool.
 */

import { decodeStrict, type Clock, type Sha } from '@fleet/foundation-core'
import { FLEET_PACE_FILE, fleetPace, type Coordination, type FleetPace } from '@fleet/foundation-contracts'

/** A heartbeat older than this reads as offline (§2.3). Three missed ten-minute heartbeats. */
export const OFFLINE_AFTER_MS = 30 * 60_000

export type PeerFleet =
  | { readonly user: string; readonly sha: Sha; readonly pace: FleetPace; readonly offline: boolean }
  | { readonly user: string; readonly sha: Sha; readonly problem: string }

export const readFleetPaces = async (input: {
  readonly coordination: Coordination
  /** The engagement code name: `eng-07`. */
  readonly namespace: string
  /** This fleet's own GitHub user, which is not a peer of itself. */
  readonly self: string
  readonly clock: Clock
  readonly offlineAfterMs?: number
}): Promise<readonly PeerFleet[]> => {
  const prefix = `${input.namespace}/fleet/`
  const offlineAfterMs = input.offlineAfterMs ?? OFFLINE_AFTER_MS
  const now = Date.parse(input.clock.now())
  const fleets: PeerFleet[] = []

  for (const ref of await input.coordination.refs(prefix)) {
    const user = ref.name.slice(prefix.length)
    if (user === input.self || user.includes('/')) continue
    const held = await input.coordination.read(ref)
    if (held === undefined) continue
    const text = held.files[FLEET_PACE_FILE]
    if (text === undefined) {
      fleets.push({ user, sha: held.sha, problem: `no ${FLEET_PACE_FILE} on the branch` })
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      fleets.push({ user, sha: held.sha, problem: `${FLEET_PACE_FILE} is not JSON` })
      continue
    }
    const decoded = decodeStrict(fleetPace(), json)
    if (!decoded.ok) {
      fleets.push({ user, sha: held.sha, problem: decoded.error.message.slice(0, 300) })
      continue
    }
    const pace = decoded.value
    fleets.push({ user, sha: held.sha, pace, offline: now - Date.parse(pace.heartbeat) > offlineAfterMs })
  }
  return fleets.sort((a, b) => (a.user < b.user ? -1 : 1))
}
