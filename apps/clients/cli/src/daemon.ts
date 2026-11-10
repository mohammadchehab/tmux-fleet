/**
 * `fleet up` on a fleet that is not running: start `fleetd` and let it go (§2).
 *
 * The daemon is a separate process and the CLI holds no state, so starting it
 * is a spawn and nothing else. What the CLI may not do is say *how*: it never
 * imports `apps/daemon` (§1.1), and it does not know where that app's source
 * lives. It runs `fleetd` — the bin the daemon's own `package.json` declares —
 * from `PATH`, which is the process boundary the architecture leaves open, and
 * `FLEET_DAEMON_BIN` names an absolute one for a checkout that is not linked.
 *
 * Detached, with its output in `~/.fleet/<profile>/daemon/fleetd.log` (§2). A
 * detached process has no terminal, so `ignore` would throw away the one line
 * that says why a daemon did not come up — and `up`'s timeout tells the user to
 * read exactly that file.
 */

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'

import { fleetError, profilePaths } from '@fleet/foundation-core'

export interface SpawnOptions {
  /** Named on the command line, so the daemon does not depend on this process's environment. */
  readonly profile: string
  /** `FLEET_DAEMON_BIN`, else `fleetd` from `PATH`. */
  readonly bin?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** `~` by default; a test points it at a temp directory, as the daemon's roots do. */
  readonly home?: string
}

/** The command `fleet up` runs, split out so a test can assert on it without spawning anything. */
export const fleetdCommand = (options: SpawnOptions): { readonly command: string; readonly args: readonly string[] } => ({
  command: options.bin ?? options.env?.['FLEET_DAEMON_BIN'] ?? 'fleetd',
  args: [options.profile],
})

/**
 * Resolves once the process has been spawned — not once the daemon is ready:
 * readiness is the socket answering, and that is `run.ts`'s poll. Rejects with
 * the reason when the bin is not there, which is the one failure a person can
 * fix (`pnpm install`, or point `FLEET_DAEMON_BIN` at the checkout).
 */
export const spawnFleetd = (options: SpawnOptions): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const { command, args } = fleetdCommand(options)
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value !== undefined) env[key] = value
    }
    // Named on the command line, so it wins over whatever the shell had.
    env['FLEET_PROFILE'] = options.profile

    // The daemon's own log, opened here because `fleet up` is what makes it a
    // detached process: `mkdir -p` for the same reason `up` creates the layout,
    // a daemon that cannot write its socket is a daemon whose reason should be
    // on disk.
    const paths = profilePaths(options.profile, options.home === undefined ? {} : { home: options.home })
    let log: number | undefined
    try {
      mkdirSync(paths.daemonDir, { recursive: true })
      log = openSync(paths.logPath, 'a')
    } catch (cause) {
      reject(fleetError('external_failed', `cannot open ${paths.logPath}: ${(cause as Error).message}`, { cause }))
      return
    }
    const closeLog = (): void => {
      if (log === undefined) return
      closeSync(log)
      log = undefined
    }

    const child = spawn(command, [...args], {
      detached: true,
      // The child holds its own copy once spawned; the parent's is closed below.
      stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'],
      env,
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      closeLog()
      reject(
        fleetError(
          'external_failed',
          error.code === 'ENOENT'
            ? `cannot start fleetd: "${command}" is not on PATH; set FLEET_DAEMON_BIN to an absolute one (a checkout runs it as node apps/daemon/src/main.ts <profile>)`
            : `cannot start fleetd: ${error.message}`,
          { cause: error, details: { command } },
        ),
      )
    })
    child.once('spawn', () => {
      closeLog()
      child.unref()
      resolve()
    })
  })
