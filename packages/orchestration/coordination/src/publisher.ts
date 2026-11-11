/**
 * Publishing this fleet's pace on its own branch (shared-fleet.md §2.1, §3).
 *
 * A tick reads the month's spend and the idle peers, and pushes only when a fact
 * changed or the last push is ten minutes old: a heartbeat every poll would be a
 * commit every 30 s per fleet, which a hundred fleets turn into a firehose, and
 * nobody acts on a pace that moved by the passage of a minute.
 *
 * The branch has one writer, so the publisher holds the sha it last pushed and
 * leases every push on it. Starting up, it adopts whatever its branch already
 * holds — a restart is not a second writer. A push refused because the branch
 * moved means one *is*: the same account publishing from another machine. That
 * is raised, not overwritten, and the next tick re-reads the branch.
 */

import { decodeStrict, fleetError, FleetError, parseStrict, type Clock, type Sha } from '@fleet/foundation-core'
import {
  FLEET_PACE_FILE,
  fleetPace,
  type Coordination,
  type FleetPace,
  type ReadModel,
} from '@fleet/foundation-contracts'
import { fleetPaceOf, monthOf, sameFacts } from './pace.ts'

export const HEARTBEAT_MS = 10 * 60_000

export interface PacePublisherOptions {
  readonly coordination: Coordination
  readonly read: Pick<ReadModel, 'tokens' | 'peers'>
  /** This fleet's branch: `<ns>/fleet/<github-user>`. */
  readonly ref: string
  readonly capUsd: number
  readonly clock: Clock
  readonly heartbeatMs?: number
}

export interface PaceTick {
  readonly pace: FleetPace
  /** False when nothing changed and the heartbeat was still fresh. */
  readonly published: boolean
  readonly sha: Sha
}

export interface PacePublisher {
  tick(): Promise<PaceTick>
}

/** The bytes a fleet pushes: exactly the schema's fields, in a fixed order, and nothing else (§9). */
export const encodePace = (pace: FleetPace): string => `${JSON.stringify(parseStrict(fleetPace(), pace), null, 2)}\n`

export const createPacePublisher = (options: PacePublisherOptions): PacePublisher => {
  if (!(options.capUsd > 0)) throw fleetError('invalid_input', `a fleet publishes a pace only against a positive cap, got ${String(options.capUsd)}`)
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  let known: { readonly sha: Sha | undefined; readonly last: FleetPace | undefined } | undefined

  /** What the branch holds now: its sha, and its document if it is one this build can read. */
  const adopt = async (): Promise<{ readonly sha: Sha | undefined; readonly last: FleetPace | undefined }> => {
    const ref = (await options.coordination.refs(options.ref)).find((candidate) => candidate.name === options.ref)
    if (ref === undefined) return { sha: undefined, last: undefined }
    const held = await options.coordination.read(ref)
    if (held === undefined) return { sha: undefined, last: undefined }
    const text = held.files[FLEET_PACE_FILE]
    const decoded = text === undefined ? undefined : decodeJson(text)
    return { sha: held.sha, last: decoded?.ok === true ? decoded.value : undefined }
  }

  return {
    async tick() {
      known ??= await adopt()
      const at = options.clock.now()
      const [spend, peers] = await Promise.all([options.read.tokens.month(monthOf(at)), options.read.peers.all()])
      const pace = fleetPaceOf({ capUsd: options.capUsd, spend, peers, at })

      const { sha, last } = known
      const fresh = last !== undefined && Date.parse(at) - Date.parse(last.heartbeat) < heartbeatMs
      if (sha !== undefined && fresh && sameFacts(last, pace)) return { pace: last, published: false, sha }

      try {
        const pushed = await options.coordination.publish({
          ref: options.ref,
          files: { [FLEET_PACE_FILE]: encodePace(pace) },
          expected: sha,
          message: `pace ${pace.pace} (${pace.month})`,
        })
        known = { sha: pushed, last: pace }
        return { pace, published: true, sha: pushed }
      } catch (thrown) {
        if (thrown instanceof FleetError && thrown.code === 'head_moved') {
          known = undefined
          throw fleetError(
            'conflict',
            `${options.ref} was written by someone else since this fleet last published; is the same account running a fleet on another machine?`,
            { cause: thrown },
          )
        }
        throw thrown
      }
    },
  }
}

const decodeJson = (text: string) => {
  try {
    return decodeStrict(fleetPace(), JSON.parse(text))
  } catch {
    return undefined
  }
}
