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
 * Detached, with stdio ignored: the daemon writes its own log at
 * `~/.fleet/<profile>/daemon/fleetd.log` (§2), and a fleet that died with the
 * terminal that started it would be no fleet at all.
 */

import { spawn } from 'node:child_process'

import { fleetError } from '@fleet/foundation-core'

export interface SpawnOptions {
  /** Named on the command line, so the daemon does not depend on this process's environment. */
  readonly profile: string
  /** `FLEET_DAEMON_BIN`, else `fleetd` from `PATH`. */
  readonly bin?: string
  readonly env?: Readonly<Record<string, string | undefined>>
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

    const child = spawn(command, [...args], { detached: true, stdio: 'ignore', env })
    child.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        fleetError(
          'external_failed',
          error.code === 'ENOENT'
            ? `cannot start fleetd: "${command}" is not on PATH; run pnpm install in the fleet checkout, or set FLEET_DAEMON_BIN`
            : `cannot start fleetd: ${error.message}`,
          { cause: error, details: { command } },
        ),
      ),
    )
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
