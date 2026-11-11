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
 * Every ten minutes, and once at start, it also compares the engagement's team
 * with the current key and rotates it on any change (§5.2) — on a timer of its
 * own, because that look is a GitHub API call and the pace's is not.
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
import type { Coordination, KeyWrap, ReadModel, TeamDirectory } from '@fleet/foundation-contracts'
import { createGh, createGitHubTeamDirectory, type Gh } from '@fleet/integrations-github'
import { createAgeKeyWrap, createGitCoordination } from '@fleet/integrations-coordination'
import {
  createPacePublisher,
  reconcileKey,
  type KeyOutcome,
  type PacePublisher,
  type PaceTick,
} from '@fleet/orchestration-coordination'
import { systemTimers, type Timers } from '@fleet/orchestration-routines'
import type { CoordProfile } from '../config/profile.ts'

/** How often the publisher looks: the idle cadence (§2.2). Pushes are rarer — see the publisher. */
export const COORDINATION_TICK_MS = 60_000

/**
 * How often the team is compared with the current key (§5.2). A leaver has lost
 * the repository the moment they leave the team, so this bounds how long the
 * pool keeps using a key they held — not how long they can read it.
 */
export const KEY_CHECK_MS = 10 * 60_000

export interface CoordinationLoop {
  /** The branch this fleet publishes on: `<engagement>/fleet/<user>`. */
  readonly ref: string
  start(): void
  stop(): void
  /** One look; the timer calls this, and so does a test. Never throws. */
  tick(): Promise<void>
  /** One comparison of the team with the key, when the loop has one. Never throws. */
  checkKey(): Promise<void>
}

export const createCoordinationLoop = (deps: {
  readonly ref: string
  readonly publisher: PacePublisher
  readonly timers?: Timers
  readonly everyMs?: number
  readonly onError?: (error: unknown) => void
  readonly onTick?: (tick: PaceTick) => void
  /** §5.2: the engagement key's rotation, on its own slower timer. */
  readonly keys?: {
    readonly reconcile: () => Promise<KeyOutcome>
    readonly everyMs?: number
    readonly onOutcome?: (outcome: KeyOutcome) => void
  }
}): CoordinationLoop => {
  const timers = deps.timers ?? systemTimers
  let timer: unknown
  let keyTimer: unknown
  let inflight: Promise<void> | undefined
  let keyInflight: Promise<void> | undefined

  const checkKey = (): Promise<void> => {
    const keys = deps.keys
    if (keys === undefined) return Promise.resolve()
    // Single-flight for the same reason as the pace: two looks racing would race
    // each other to the same rotation and log a lost race against themselves.
    return (keyInflight ??= (async () => {
      try {
        keys.onOutcome?.(await keys.reconcile())
      } catch (error) {
        deps.onError?.(error)
      } finally {
        keyInflight = undefined
      }
    })())
  }

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
      if (deps.keys !== undefined) {
        void checkKey()
        keyTimer = timers.setInterval(() => void checkKey(), deps.keys.everyMs ?? KEY_CHECK_MS)
      }
    },
    stop() {
      if (timer !== undefined) timers.clearInterval(timer)
      if (keyTimer !== undefined) timers.clearInterval(keyTimer)
      timer = undefined
      keyTimer = undefined
    },
    tick,
    checkKey,
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
  /** §5.1's team; defaults to `gh api` against GitHub. */
  readonly directory?: TeamDirectory
  /** §5.1's sealing; defaults to the `age` binary. */
  readonly wrap?: KeyWrap
  readonly timers?: Timers
}

/** The log's one line for a look at the key; silent when nothing changed. */
export const keyOutcomeLine = (ref: string, outcome: KeyOutcome): string | undefined => {
  switch (outcome.kind) {
    case 'current':
    case 'lost_race':
      return undefined
    case 'rotated': {
      const missing =
        outcome.missing.length === 0
          ? ''
          : `; no copy for ${outcome.missing.join(', ')}, who ha${outcome.missing.length === 1 ? 's' : 've'} no ssh-ed25519 or ssh-rsa key on GitHub`
      return `fleetd: shared fleet ${ref}: made key rotation ${outcome.rotation} for ${outcome.members.length} member(s)${missing}`
    }
    case 'refused':
      return `fleetd: shared fleet ${ref}: the key was not rotated: ${outcome.reason}`
  }
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
  const directory = wiring.directory ?? createGitHubTeamDirectory()
  const wrap = wiring.wrap ?? createAgeKeyWrap({ cwd: wiring.paths.stateDir })
  return createCoordinationLoop({
    ref,
    publisher,
    keys: {
      reconcile: () =>
        reconcileKey({
          coordination,
          directory,
          wrap,
          namespace: wiring.coord.engagement,
          team: wiring.coord.team,
          self: user,
          clock: wiring.clock,
        }),
      onOutcome: (outcome) => {
        const line = keyOutcomeLine(ref, outcome)
        if (line !== undefined) console.error(line)
      },
    },
    ...(wiring.timers === undefined ? {} : { timers: wiring.timers }),
    onError: (error) => {
      // A pace that did not go out is a fleet the others see as quiet, not a fleet
      // that is down: logged, and the next tick tries again.
      console.error(`fleetd: shared fleet ${ref}: ${error instanceof Error ? error.message : String(error)}`)
    },
  })
}
