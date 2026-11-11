/**
 * Which fleet this window is looking at (§7), decided in one place and without
 * touching a disk — the scan that finds the candidates is `profiles.ts`, so
 * this file is a pure function of what was found.
 *
 * The order is the clients' order, and the reason it is the same one is that a
 * person runs `fleet ls` and the editor side by side: the two disagreeing about
 * which fleet is "the" fleet is the bug they would report as "the editor shows
 * a different fleet".
 *
 * 1. `fleet.socket` — this socket, whatever it is.
 * 2. `fleet.profile` — the layout below, by name.
 * 3. `FLEET_SOCKET`, then `FLEET_PROFILE` — the environment the editor was
 *    started from. A setting beats a variable, and either beats a scan.
 * 4. the profiles with a running daemon: one is used, several are a question
 *    for the person (§7), and the answer is saved as `fleet.profile`.
 *
 * A socket setting is expanded against the extension host's home, because
 * editor settings do not expand `~` — a person who wrote `~/.fleet/x/...`
 * means their own home, which over Remote-SSH is the *remote* one.
 */

import { profilePaths } from '@fleet/foundation-core'

export interface DiscoveryInput {
  /** `fleet.socket`, verbatim. */
  readonly socket: string | undefined
  /** `fleet.profile`, which may be the answer to an earlier `choose`. */
  readonly profile: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  /** The extension host's home: the local one, or the remote one in Remote-SSH (§7). */
  readonly home: string
  /** Profile names whose `daemon/fleetd.sock` exists, as `profiles.ts` found them. */
  readonly running: readonly string[]
}

export type Discovery =
  /** A socket was named (or a profile was, and the layout gave the path). */
  | { readonly kind: 'socket'; readonly socketPath: string; readonly profile?: string; readonly via: 'setting' | 'env' | 'profile' }
  /** Several fleets are running and nobody has said which; the caller asks once (§7). */
  | { readonly kind: 'choose'; readonly profiles: readonly string[] }
  /** Nothing to look at: no fleet is running for this folder. */
  | { readonly kind: 'none' }

const given = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim()

/** `~` and `~/x` against `home`; anything else is left exactly as written. */
export const expandHome = (path: string, home: string): string => {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`
  return path
}

export const discover = (input: DiscoveryInput): Discovery => {
  const socketSetting = given(input.socket)
  const profileSetting = given(input.profile)

  if (socketSetting !== undefined) {
    return {
      kind: 'socket',
      socketPath: expandHome(socketSetting, input.home),
      via: 'setting',
      ...(profileSetting === undefined ? {} : { profile: profileSetting }),
    }
  }

  if (profileSetting !== undefined) {
    return {
      kind: 'socket',
      socketPath: profilePaths(profileSetting, { home: input.home }).socketPath,
      profile: profileSetting,
      via: 'profile',
    }
  }

  const envSocket = given(input.env['FLEET_SOCKET'])
  if (envSocket !== undefined) {
    const envProfile = given(input.env['FLEET_PROFILE'])
    return {
      kind: 'socket',
      socketPath: expandHome(envSocket, input.home),
      via: 'env',
      ...(envProfile === undefined ? {} : { profile: envProfile }),
    }
  }

  const envProfile = given(input.env['FLEET_PROFILE'])
  if (envProfile !== undefined) {
    return {
      kind: 'socket',
      socketPath: profilePaths(envProfile, { home: input.home }).socketPath,
      profile: envProfile,
      via: 'env',
    }
  }

  const running = [...new Set(input.running)].sort()
  const only = running.length === 1 ? running[0] : undefined
  if (only !== undefined) {
    return {
      kind: 'socket',
      socketPath: profilePaths(only, { home: input.home }).socketPath,
      profile: only,
      via: 'profile',
    }
  }
  if (running.length > 1) return { kind: 'choose', profiles: running }
  return { kind: 'none' }
}
