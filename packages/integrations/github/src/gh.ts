/**
 * The `gh` half of the integration: one injected runner, no shell, and a `json`
 * that turns a non-zero exit or unparseable output into a typed `FleetError`.
 *
 * The runner is the seam. §10's gate and the retarget sweep never see a
 * process: they see `PullRequests`, which this package builds over a `Gh`, which
 * is one function away from `gh`. A test supplies that function and asserts the
 * argv, so nothing in the suite authenticates, hits the network, or depends on
 * `gh` being installed.
 */

import { execFile } from 'node:child_process'
import { fleetError, FleetError, toFleetError } from '@fleet/foundation-core'

export interface GhResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs `gh` with argv, no shell. Resolves on a non-zero exit too — the caller
 * decides what a failure means — so only a spawn failure is a rejection.
 */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>

/** `gh` on `PATH`. A missing binary surfaces as code 1 with the spawn message on stderr. */
export const execFileGh: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile('gh', [...args], { maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
        return
      }
      const code = typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
    })
  })

/** One `gh` call, as this package uses it: the raw result, or its stdout parsed as JSON. */
export interface Gh {
  run(args: readonly string[]): Promise<GhResult>
  /** A non-zero exit is an `external_failed` `FleetError`, never a throw from `JSON.parse`. */
  json(args: readonly string[]): Promise<unknown>
}

/** The argv's first two words, which is what an error message can safely quote: a body or a title is not. */
const label = (args: readonly string[]): string => args.slice(0, 2).join(' ')

export const createGh = (runner: GhRunner = execFileGh): Gh => ({
  run: (args) => runner(args),

  async json(args) {
    const result = await runner(args)
    if (result.code !== 0) {
      throw fleetError('external_failed', `gh ${label(args)} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
        details: { argv: args.slice(0, 2), exitCode: result.code },
      })
    }
    try {
      return JSON.parse(result.stdout) as unknown
    } catch (thrown) {
      throw fleetError('external_failed', `gh ${label(args)} printed no JSON`, { cause: thrown })
    }
  },
})

/** A failure the caller wanted to interpret rather than raise, kept as the `FleetError` every boundary speaks. */
export const asFleetError = (thrown: unknown): FleetError => toFleetError(thrown, 'external_failed')
