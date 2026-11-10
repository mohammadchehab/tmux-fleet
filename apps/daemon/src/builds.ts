/**
 * §11's ledger, as the daemon composes it: one ledger, two runners, and the
 * profile's routing.
 *
 * `apps/daemon` is the only place a concrete runner is named (§2), for the same
 * reason it is the only place a concrete provider is: the ledger knows *whether*
 * a build runs and the profile knows *where* heavy work goes, and neither should
 * have to know that "where" is an `ssh` to a box someone calls hetzner.
 *
 * A profile with no `builds` block gets a local-only ledger — every task runs on
 * this box, nothing is heavy. That is the honest default: a fleet that has not
 * named a remote host still records its builds, so the ledger is never absent
 * from the daemon's API and a caller never has to wonder whether it exists.
 */

import type { BuildReader, EventSink } from '@fleet/foundation-contracts'
import type { Clock } from '@fleet/foundation-core'
import {
  createBuildLedger,
  createLocalRunner,
  createRemoteRunner,
  type BuildLedger,
  type BuildRouting,
  type RunProcess,
} from '@fleet/orchestration-ledger'

import type { Profile, ProfileBuilds } from './profile.ts'

/** The routing a profile asks for, as the ledger takes it. */
export const routingOf = (builds: ProfileBuilds | undefined): BuildRouting => ({
  host: builds?.host ?? 'local',
  heavy: builds?.heavy ?? [],
})

export interface DaemonBuildsOptions {
  readonly profile: Pick<Profile, 'builds'>
  /** Where the events go: the waking sink in a composed fleet, so a finished build wakes the routines. */
  readonly sink: EventSink
  /** The projection's builds, for the dedupe (`store.reader().builds`). */
  readonly builds: BuildReader
  /** `~/.fleet/<profile>/artifacts/builds` (`persistentDirs`). */
  readonly logDir: string
  readonly clock?: Clock
  /** Injected so a test composes a fleet without spawning a build or an `ssh`. */
  readonly process?: RunProcess
}

export const createDaemonBuilds = (options: DaemonBuildsOptions): BuildLedger => {
  const builds = options.profile.builds
  const injected = options.process === undefined ? {} : { process: options.process }
  const local = createLocalRunner(injected)
  const remote =
    builds?.remote === undefined
      ? undefined
      : createRemoteRunner({
          target: builds.remote.target,
          root: builds.remote.root,
          ...(builds.remote.remote === undefined ? {} : { remote: builds.remote.remote }),
          ...injected,
        })

  return createBuildLedger({
    store: options.sink,
    builds: options.builds,
    routing: routingOf(builds),
    runners: { local, ...(remote === undefined ? {} : { remote }) },
    logDir: options.logDir,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
}
