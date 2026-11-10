/**
 * The `backlog` half of the adapter: one injected runner, no shell, and a `json`
 * that turns a non-zero exit or unparseable output into a typed `FleetError`.
 *
 * The runner is the seam, exactly as `gh.ts` is for the forge. `tracker-sync`
 * never sees a process: it sees `Tracker`, which this package builds over a
 * `BacklogCli`, which is one function away from `backlog`. A test supplies that
 * function and asserts the argv, so nothing in the suite initialises a project,
 * reads the disk, or depends on the CLI being installed.
 *
 * **`cwd` is part of the call, not of the process.** Backlog.md is a directory
 * of markdown (`backlog/tasks/*.md`), and which project a command means is
 * decided by where it runs. Passing it per call keeps two trackers in one
 * daemon from reading each other's board, which a `process.chdir` would not.
 */

import { execFile } from 'node:child_process'
import { fleetError } from '@fleet/foundation-core'

export interface BacklogResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs `backlog` with argv, no shell, in a directory. Resolves on a non-zero
 * exit too — the caller decides what a failure means — so only a spawn failure
 * is a rejection.
 */
export type BacklogRunner = (
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<BacklogResult>

/**
 * `backlog` on `PATH`. A missing binary surfaces as code 127 with the spawn
 * message on stderr, the way a shell reports it, so `transition`/`get` can tell
 * "the CLI is not installed" from "the CLI answered no".
 */
export const execFileBacklog: BacklogRunner = (args, options) =>
  new Promise((resolve) => {
    execFile('backlog', [...args], { cwd: options.cwd, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
        return
      }
      const code = typeof error.code === 'number' ? error.code : 127
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
    })
  })

/** One `backlog` call, as this package uses it: the raw result, or its stdout parsed as JSON. */
export interface BacklogCli {
  run(args: readonly string[]): Promise<BacklogResult>
  /** A non-zero exit is an `external_failed` `FleetError`, never a throw from `JSON.parse`. */
  json(args: readonly string[]): Promise<unknown>
}

/**
 * The argv's first two words, which is what an error message can safely quote: a
 * task body or a note is not, and an error line travels into `routine.failed`.
 */
const label = (args: readonly string[]): string => args.slice(0, 3).join(' ')

export const createBacklogCli = (cwd: string, runner: BacklogRunner = execFileBacklog): BacklogCli => ({
  run: (args) => runner(args, { cwd }),

  async json(args) {
    const result = await runner(args, { cwd })
    if (result.code !== 0) {
      throw fleetError('external_failed', `backlog ${label(args)} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
        details: { argv: args.slice(0, 3), exitCode: result.code },
      })
    }
    try {
      return JSON.parse(result.stdout) as unknown
    } catch (thrown) {
      throw fleetError('external_failed', `backlog ${label(args)} printed no JSON`, { cause: thrown })
    }
  },
})
