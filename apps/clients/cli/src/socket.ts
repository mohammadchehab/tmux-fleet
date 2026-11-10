/**
 * Which daemon the CLI is talking to (§2), decided in one place.
 *
 * Three ways to name a fleet, most explicit first:
 *
 * 1. `--socket <path>` — this socket, whatever it is. What a test, a second
 *    profile on unusual roots, or a daemon someone started by hand needs.
 * 2. `--profile <name>` — the layout below, with the name given on the command
 *    line.
 * 3. the environment — `FLEET_SOCKET`, which the daemon puts in every peer's
 *    session, so a peer runs `fleet ls` and `fleet peek engineer-1` with no
 *    arguments at all (§8); then `FLEET_PROFILE`, which is what `fleetd`
 *    itself reads.
 *
 * Flags beat the environment, because a person typing a flag means it more
 * than a variable their shell exported an hour ago.
 *
 * The layout itself — `~/.fleet/<profile>/daemon/fleetd.sock` — is `profilePaths`
 * in `@fleet/foundation-core`, which is what `fleetd` derives too. One function,
 * so the CLI cannot look for a socket the daemon did not create (§1.1).
 */

import { fleetError, profilePaths } from '@fleet/foundation-core'

export interface SocketRequest {
  /** `--socket`, verbatim. */
  readonly socket?: string
  /** `--profile`, or `up`'s positional argument. */
  readonly profile?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** `~` by default; a test points it at a temp directory, as the daemon's roots do. */
  readonly home?: string
}

export interface SocketChoice {
  readonly socketPath: string
  /**
   * The profile, when one was named. `fleet up` needs it to start `fleetd`;
   * an explicit `--socket` or `FLEET_SOCKET` names no profile, and `up` then
   * has nothing to start and says so.
   */
  readonly profile?: string
}

const given = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

export const socketPathOf = (request: SocketRequest): SocketChoice => {
  const explicitSocket = given(request.socket)
  const explicitProfile = given(request.profile)
  const env = request.env ?? {}
  const profile = explicitProfile ?? given(env['FLEET_PROFILE'])

  if (explicitSocket !== undefined) {
    return { socketPath: explicitSocket, ...(explicitProfile === undefined ? {} : { profile: explicitProfile }) }
  }

  // `--profile` given explicitly wins over `FLEET_SOCKET`: a flag is a decision
  // about *this* command, and the variable belongs to the shell that started it.
  if (explicitProfile === undefined) {
    const fromEnv = given(env['FLEET_SOCKET'])
    if (fromEnv !== undefined) return { socketPath: fromEnv, ...(profile === undefined ? {} : { profile }) }
  }

  if (profile === undefined) {
    throw fleetError(
      'invalid_input',
      'no fleet named: pass --socket <path>, or name a profile (fleet up <profile>), or set FLEET_SOCKET',
    )
  }

  // `profilePaths` refuses a name that would become a path, and derives the
  // same socket `fleetd` opens for it.
  const { socketPath } = profilePaths(profile, request.home === undefined ? {} : { home: request.home })
  return { socketPath, profile }
}
