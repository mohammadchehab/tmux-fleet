/**
 * Shared fleet coordination routines (architecture §2, §6, §9): polling and
 * publishing pace, capacity, and heartbeat to the fleet-coord repository.
 *
 * Phase 1 publishes budget pace and capacity. Phase 2+ adds masked claims/bids.
 * The polling interval is 30-60 seconds (deterministic code, no model, no tokens).
 */

import type { CoordinationFleetState, Coordination } from '@fleet/foundation-contracts'
import type { ReadModel } from '@fleet/foundation-contracts'
import type { PeerId, Result, FleetError, Repo } from '@fleet/foundation-core'
import { err, ok, fleetError } from '@fleet/foundation-core'

/**
 * Information the coordination routine needs to publish pace and capacity.
 * Supplied by the daemon at startup.
 */
export interface CoordinationConfig {
  readonly engagement: string
  readonly team: string
  readonly repo: Repo
  readonly checkoutPath: string
  readonly peerId: PeerId
}

/** What the routine collects and publishes each poll. */
export interface CoordinationSnapshot {
  readonly budget: {
    readonly cap: number
    readonly spent: number
    readonly pace: number
  }
  readonly capacity: readonly { readonly role: string; readonly idle: number }[]
  readonly heartbeat: string
}

/**
 * Collect pace and capacity from the current fleet state (§3). The caller
 * reads TokenReport (one per peer and Work) and PeerActivity (one per peer
 * doing something right now) to build this snapshot.
 */
export function collectSnapshot(input: {
  readonly monthlyCap: number
  readonly spent: number
  readonly elapsedPercent: number
  readonly capacity: ReadonlyMap<string, number>
}): CoordinationSnapshot {
  const pace = input.spent / input.monthlyCap / (input.elapsedPercent / 100)
  return {
    budget: {
      cap: input.monthlyCap,
      spent: input.spent,
      pace,
    },
    capacity: Array.from(input.capacity.entries()).map(([role, idle]) => ({ role, idle })),
    heartbeat: new Date().toISOString(),
  }
}

/**
 * Publish the fleet's pace and capacity to its own branch in the coordination
 * repository. Called periodically (30-60 seconds) by the daemon's poll loop.
 *
 * The routine:
 * 1. Collects the current budget and capacity
 * 2. Formats it as JSON
 * 3. Commits to the fleet's branch and pushes
 * 4. Polls the repo to discover other fleets' updates
 */
export async function publishPaceAndCapacity(input: {
  readonly config: CoordinationConfig
  readonly coordination: Coordination
  readonly snapshot: CoordinationSnapshot
}): Promise<Result<{ readonly pushed: boolean }, FleetError>> {
  try {
    const state: CoordinationFleetState = {
      budget: input.snapshot.budget,
      capacity: input.snapshot.capacity,
      heartbeat: input.snapshot.heartbeat,
    }

    const message = `fleet ${input.config.peerId}: pace=${state.budget.pace.toFixed(2)}, capacity=${JSON.stringify(state.capacity)}`

    await input.coordination.push({
      repo: input.config.repo,
      cwd: input.config.checkoutPath,
      branch: `${input.config.engagement}/fleet/${input.config.peerId}`,
      message,
    })

    return ok({ pushed: true })
  } catch (e) {
    return err(fleetError('external_failed', `Failed to publish pace and capacity: ${String(e)}`))
  }
}

/**
 * Poll the coordination repository to discover other fleets' pace and capacity.
 * Returns all refs and their commits; the caller filters for engagement-specific
 * ones and parses the data (phase 2+: masked claims/bids).
 */
export async function pollRepository(input: {
  readonly coordination: Coordination
  readonly repo: Repo
}): Promise<Result<readonly { readonly ref: string; readonly sha: string }[], FleetError>> {
  try {
    const refs = await input.coordination.listRefs(input.repo)
    return ok(refs.map((r) => ({ ref: r.name, sha: r.sha })))
  } catch (e) {
    return err(fleetError('external_failed', `Failed to poll repository: ${String(e)}`))
  }
}
