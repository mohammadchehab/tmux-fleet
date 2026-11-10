/**
 * Which host a build runs on (§11).
 *
 * "Heavy tasks route to the remote host (hetzner) by task class in the profile;
 * light ones run locally." The profile names the classes that are heavy; this
 * file is the rule, so the profile is a list of classes and not a second copy of
 * the routing logic.
 */

import { fleetError } from '@fleet/foundation-core'
import type { BuildHost } from '@fleet/foundation-contracts'
import { buildTaskClass } from './task.ts'

export interface BuildRouting {
  /** Where a task that is not heavy runs. `local` in every profile we ship. */
  readonly host: BuildHost
  /** Task classes that go to the remote host. Empty means "nothing is heavy yet". */
  readonly heavy: readonly string[]
}

/**
 * The host for one task. Matching is on the class only: a profile that marks
 * `evals` heavy marks every suite and every model heavy, which is the point of
 * routing by class (§11).
 */
export const routeBuildHost = (task: string, routing: BuildRouting): BuildHost =>
  routing.heavy.includes(buildTaskClass(task)) ? 'remote' : routing.host

/**
 * A routing that names a host no runner can serve would fail on the first heavy
 * task, half an hour after the profile was read. It is refused when the ledger
 * is built instead, so a profile that says `heavy: [evals]` without a remote
 * block is a `fleet up` that says so, not a build that stalls.
 */
export const validateRouting = (routing: BuildRouting, available: readonly BuildHost[]): BuildRouting => {
  if (routing.heavy.length === 0 || available.includes('remote')) return routing
  throw fleetError(
    'invalid_input',
    `the profile routes ${routing.heavy.join(', ')} to the remote host but no remote build host is configured; add one, or remove the class from builds.heavy`,
    { details: { heavy: [...routing.heavy] } },
  )
}
