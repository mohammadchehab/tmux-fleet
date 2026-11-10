/**
 * The `glab` half of the integration: one injected runner, no shell, and a `json`
 * that turns a non-zero exit or unparseable output into a typed `FleetError`.
 *
 * The runner is the seam, exactly as it is for `gh` in `@fleet/integrations-github`.
 * §10's gate and the retarget sweep never see a process: they see `PullRequests`,
 * which this package builds over a `Glab`, which is one function away from `glab`.
 * A test supplies that function and asserts the argv, so nothing in the suite
 * authenticates, hits the network, or depends on `glab` being installed.
 *
 * **The host is the profile's, never the machine's.** `glab` resolves its host
 * from the current directory's git remote or from its own config, and neither is
 * something a fleet can rely on: the daemon writes worktrees, and a developer's
 * `glab auth login` is not a daemon setting. So the host arrives as
 * `forge.host` in the profile and is exported to every child as `GITLAB_HOST`,
 * which is the one channel all of `glab`'s subcommands honour (`--hostname`
 * exists on `glab api` alone). A profile with no host inherits the environment,
 * which is what makes `gitlab.com` work without naming a host at all.
 */

import { execFile } from 'node:child_process'
import { fleetError, FleetError, toFleetError } from '@fleet/foundation-core'

export interface GlabResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs `glab` with argv, no shell. Resolves on a non-zero exit too — the caller
 * decides what a failure means — so only a spawn failure is a rejection.
 */
export type GlabRunner = (args: readonly string[]) => Promise<GlabResult>

/**
 * `glab` on `PATH`, with `host` pinned in the child's environment when the
 * profile named one. A missing binary surfaces as code 1 with the spawn message
 * on stderr, the same shape `execFileGh` gives.
 */
export const execFileGlab = (host?: string): GlabRunner => (args) =>
  new Promise((resolve) => {
    const env = host === undefined ? process.env : { ...process.env, GITLAB_HOST: host }
    execFile('glab', [...args], { maxBuffer: 4 << 20, env }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
        return
      }
      const code = typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
    })
  })

/** One `glab` call, as this package uses it: the raw result, or its stdout parsed as JSON. */
export interface Glab {
  run(args: readonly string[]): Promise<GlabResult>
  /** A non-zero exit is an `external_failed` `FleetError`, never a throw from `JSON.parse`. */
  json(args: readonly string[]): Promise<unknown>
}

export interface GlabOptions {
  /** Defaults to `glab` on `PATH` through `execFile`, with `host` exported to it. A test supplies a fake. */
  readonly runner?: GlabRunner
  /** The profile's `forge.host`. Absent means `glab`'s own resolution — its config, or the cwd's remote. */
  readonly host?: string
}

/** The argv's first two words, which is what an error message can safely quote: a title or a body is not. */
const label = (args: readonly string[]): string => args.slice(0, 2).join(' ')

export const createGlab = (options: GlabOptions = {}): Glab => {
  const runner = options.runner ?? execFileGlab(options.host)

  return {
    run: (args) => runner(args),

    async json(args) {
      const result = await runner(args)
      if (result.code !== 0) {
        throw fleetError('external_failed', `glab ${label(args)} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
          details: { argv: args.slice(0, 2), exitCode: result.code },
        })
      }
      try {
        return JSON.parse(result.stdout) as unknown
      } catch (thrown) {
        throw fleetError('external_failed', `glab ${label(args)} printed no JSON`, { cause: thrown })
      }
    },
  }
}

/** A failure the caller wanted to interpret rather than raise, kept as the `FleetError` every boundary speaks. */
export const asFleetError = (thrown: unknown): FleetError => toFleetError(thrown, 'external_failed')
