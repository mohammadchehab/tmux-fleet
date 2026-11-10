#!/usr/bin/env node
/**
 * `fleetd` the process (§2): parse the profile name, compose, `up`, stay alive.
 *
 * Everything interesting is in `compose.ts`; this file is the smallest thing
 * that can hold a daemon — argv in, signals out — and its failure is an exit
 * code a shell can see. `fleet down` ends the process the same way a signal
 * does, from `compose`'s `onDown`, so there are exactly two roads out and both
 * close every port first.
 *
 * Usage: `fleetd <profile>` or `FLEET_PROFILE=<profile> fleetd`. The profile is
 * a name, never a path: `~/.config/fleet/profiles/<profile>.yaml` is fixed by
 * §2, and `parseProfileName` refuses anything that is not one.
 */

import { parseProfileName, profilePaths } from '@fleet/foundation-core'

import { compose } from './compose.ts'

const profileNameOf = (argv: readonly string[], env: Readonly<Record<string, string | undefined>>): string => {
  const named = argv.slice(2).find((arg) => !arg.startsWith('-'))
  const fromEnv = env['FLEET_PROFILE']
  const candidate = named ?? fromEnv
  if (candidate === undefined || candidate.length === 0) {
    throw new Error('usage: fleetd <profile>  (or set FLEET_PROFILE)')
  }
  return parseProfileName(candidate)
}

const main = async (): Promise<void> => {
  const profileName = profileNameOf(process.argv, process.env)
  const paths = profilePaths(profileName)
  const composed = await compose({ profileName })
  const status = await composed.daemon.up()

  console.error(`fleetd: ${status.profile} up, pid ${status.pid}, socket ${status.socketPath}`)
  console.error(`fleetd: state in ${paths.stateDir}`)

  const shutdown = (signal: string): void => {
    console.error(`fleetd: ${signal}, going down`)
    void (async () => {
      try {
        await composed.daemon.down()
        await composed.server.close()
        await composed.store.close()
        await composed.lock.release()
        process.exit(0)
      } catch (error) {
        console.error(`fleetd: failed to shut down cleanly: ${String(error)}`)
        process.exit(1)
      }
    })()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  // One line, no stack for the expected refusals (a bad profile, a dead socket);
  // the stack when it is something else, because that is a bug in the daemon.
  console.error(`fleetd: ${error instanceof Error ? error.message : String(error)}`)
  if (!(error instanceof Error) || error.name === 'FleetError') process.exit(1)
  console.error(error)
  process.exit(1)
})
