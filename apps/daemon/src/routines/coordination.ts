/**
 * The shared fleet's loop (shared-fleet.md §2.2, §3): every minute, this fleet's
 * pace is checked against what it last published, and pushed when a fact
 * changed or the ten-minute heartbeat is due.
 *
 * It is a timer of its own and not a §6 routine on purpose. A routine run is two
 * events in the log, and a once-a-minute check that usually decides "nothing
 * changed" would write ~2,900 of them a day saying so. The tick reads the local
 * projections; only a push leaves the machine, and the publisher decides when.
 *
 * In phase 1 nothing is ever *pending* — there are no bids or claims behind
 * `taskData: false` — so the loop runs at the idle cadence the design names, and
 * the 30 s pending cadence arrives with claims (§9 PR 4). A laptop asleep runs no
 * timer, which is the third cadence, for free.
 *
 * This file is the only place that knows both the git transport and the
 * publisher (§1.1): `compose.ts` calls `coordinationFor` and hands the daemon
 * the loop.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fleetError, type Clock, type ProfilePaths } from '@fleet/foundation-core'
import type { Coordination, ReadModel } from '@fleet/foundation-contracts'
import { createGh, type Gh } from '@fleet/integrations-github'
import { createGitCoordination } from '@fleet/integrations-coordination'
import { createPacePublisher, type PacePublisher, type PaceTick } from '@fleet/orchestration-coordination'
import { systemTimers, type Timers } from '@fleet/orchestration-routines'
import type { CoordProfile } from '../config/profile.ts'

/** How often the publisher looks: the idle cadence (§2.2). Pushes are rarer — see the publisher. */
export const COORDINATION_TICK_MS = 60_000

export interface CoordinationLoop {
  /** The branch this fleet publishes on: `<engagement>/fleet/<user>`. */
  readonly ref: string
  start(): void
  stop(): void
  /** One look; the timer calls this, and so does a test. Never throws. */
  tick(): Promise<void>
}

export const createCoordinationLoop = (deps: {
  readonly ref: string
  readonly publisher: PacePublisher
  readonly timers?: Timers
  readonly everyMs?: number
  readonly onError?: (error: unknown) => void
  readonly onTick?: (tick: PaceTick) => void
}): CoordinationLoop => {
  const timers = deps.timers ?? systemTimers
  let timer: unknown
  let inflight: Promise<void> | undefined

  const tick = (): Promise<void> =>
    // A push slower than the interval must not be overtaken by the next tick:
    // two pushes leased on the same sha would make this fleet its own conflict.
    (inflight ??= (async () => {
      try {
        const result = await deps.publisher.tick()
        deps.onTick?.(result)
      } catch (error) {
        deps.onError?.(error)
      } finally {
        inflight = undefined
      }
    })())

  return {
    ref: deps.ref,
    start() {
      if (timer !== undefined) return
      void tick()
      timer = timers.setInterval(() => void tick(), deps.everyMs ?? COORDINATION_TICK_MS)
    },
    stop() {
      if (timer === undefined) return
      timers.clearInterval(timer)
      timer = undefined
    },
    tick,
  }
}

/** The fleet's version, for the user agent the transport sends (§2.2). */
const fleetVersion = (): string => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/

/** The GitHub login `gh` is signed in as, which is whose branch this fleet writes. */
export const githubLogin = async (gh: Gh = createGh()): Promise<string> => {
  const result = await gh.run(['api', 'user', '--jq', '.login'])
  const login = result.stdout.trim()
  if (result.code !== 0 || !GITHUB_LOGIN.test(login)) {
    throw fleetError(
      'invalid_input',
      `a shared fleet needs the GitHub login it publishes as, and \`gh api user\` did not give one (${result.stderr.trim() || 'no output'}); sign in with \`gh auth login\` or set \`coord.user\``,
    )
  }
  return login
}

export interface CoordinationWiring {
  readonly coord: CoordProfile
  readonly capUsd: number
  readonly paths: Pick<ProfilePaths, 'stateDir'>
  readonly read: Pick<ReadModel, 'tokens' | 'peers'>
  readonly clock: Clock
  /** The transport; defaults to git against `https://github.com/<coord.repo>.git`. */
  readonly coordination?: Coordination
  /** Who this fleet is when `coord.user` is absent; defaults to asking `gh`. */
  readonly login?: () => Promise<string>
  readonly timers?: Timers
}

export const coordinationFor = async (wiring: CoordinationWiring): Promise<CoordinationLoop> => {
  const user = wiring.coord.user ?? (await (wiring.login ?? githubLogin)())
  const ref = `${wiring.coord.engagement}/fleet/${user}`
  const coordination =
    wiring.coordination ??
    createGitCoordination({
      remote: `https://github.com/${wiring.coord.repo}.git`,
      cache: join(wiring.paths.stateDir, 'coord', 'cache.git'),
      author: { name: user, email: `${user}@users.noreply.github.com` },
      version: fleetVersion(),
    })
  const publisher = createPacePublisher({ coordination, read: wiring.read, ref, capUsd: wiring.capUsd, clock: wiring.clock })
  return createCoordinationLoop({
    ref,
    publisher,
    ...(wiring.timers === undefined ? {} : { timers: wiring.timers }),
    onError: (error) => {
      // A pace that did not go out is a fleet the others see as quiet, not a fleet
      // that is down: logged, and the next tick tries again.
      console.error(`fleetd: shared fleet ${ref}: ${error instanceof Error ? error.message : String(error)}`)
    },
  })
}
