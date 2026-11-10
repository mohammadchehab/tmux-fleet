/**
 * Which daemon the board is reading (§2), decided in one place.
 *
 * The same order the CLI uses, because a person runs both and one of them
 * guessing differently would be a bug they would report as "the board shows a
 * different fleet":
 *
 * 1. `--socket <path>` — this socket, whatever it is.
 * 2. `--profile <name>` — the layout below, by name.
 * 3. the environment — `FLEET_SOCKET`, which the daemon puts in every peer's
 *    session, then `FLEET_PROFILE`, which `fleetd` itself reads.
 *
 * A flag beats the environment, and `--profile` beats `FLEET_SOCKET`: a flag is
 * a decision about this command, a variable belongs to the shell that started
 * it. The layout — `~/.fleet/<profile>/daemon/fleetd.sock` — is `profilePaths`
 * in `@fleet/foundation-core`, the same function the daemon derives it with, so
 * the view cannot look for a socket the daemon did not create.
 *
 * This is a copy of `apps/clients/cli/src/socket.ts`, as the view's is, on purpose: apps
 * never import each other (§1.1), and the alternative — a shared package for
 * forty lines of precedence — would make every client depend on a third thing
 * to read two environment variables. What is *not* duplicated is the shape of
 * an answer; that lives in `@fleet/foundation-contracts` and both decode with it.
 */

import { fleetError, profilePaths } from '@fleet/foundation-core'

export interface SocketRequest {
  /** `--socket`, verbatim. */
  readonly socket?: string
  /** `--profile`. */
  readonly profile?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** `~` by default; a test points it at a temp directory, as the daemon's roots do. */
  readonly home?: string
}

export interface SocketChoice {
  readonly socketPath: string
  /** The profile, when one was named. The tmux session is named after it. */
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

  if (explicitProfile === undefined) {
    const fromEnv = given(env['FLEET_SOCKET'])
    if (fromEnv !== undefined) return { socketPath: fromEnv, ...(profile === undefined ? {} : { profile }) }
  }

  if (profile === undefined) {
    throw fleetError(
      'invalid_input',
      'no fleet named: pass --socket <path>, or --profile <name>, or set FLEET_SOCKET',
    )
  }

  const { socketPath } = profilePaths(profile, request.home === undefined ? {} : { home: request.home })
  return { socketPath, profile }
}
