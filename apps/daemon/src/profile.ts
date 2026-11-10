/**
 * The profile (architecture §2, "On disk"): `~/.config/fleet/profiles/<profile>.yaml`.
 *
 * A profile says what this fleet *is* — which repos, which peers, which routines,
 * where notifications go — and never how the daemon is built. It is read once,
 * at `fleet up`, and decoded strictly: a misspelt key is a fleet that quietly
 * does something else, which is exactly the failure the store's `append` refuses
 * to have, so the profile is held to the same standard (§3).
 *
 * What is deliberately *not* here: live peers, sessions, briefs. Those are
 * events in the store (§3). A profile that named a session would be a second
 * source of truth for something the store already owns.
 */

import { readFile } from 'node:fs/promises'
import {
  array,
  boolean,
  fleetError,
  objectAs,
  oneOf,
  optional,
  parseStrict,
  peerId,
  positiveInt,
  text,
  type Schema,
} from '@fleet/foundation-core'
import type { PeerId } from '@fleet/foundation-core'
import { parse as parseYaml } from 'yaml'
import type { RoutinesConfig } from '@fleet/orchestration-routines'

/** The providers this daemon can wire up today. A profile names one per peer. */
export const profileProviders = ['claude', 'deepinfra'] as const
export type ProfileProvider = (typeof profileProviders)[number]

/** §13's four modes, as the provider interface reports them (§4). */
export const permissionModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const
export type PermissionModeName = (typeof permissionModes)[number]

/**
 * One peer as the profile declares it. A *declaration*, not a live peer: the
 * `peer.registered` event the daemon writes on `up` is what makes it real (§3).
 */
export interface PeerProfile {
  readonly id: PeerId
  /** The role the brief is built from (§12): `engineer`, `architect`, `devops`, … */
  readonly role: string
  readonly provider: ProfileProvider
  /**
   * The model the session starts on; the PM may switch it later (§4 `setModel`).
   * Required, because `peer.registered` carries it and a default would be the
   * daemon inventing a policy for how much this peer is allowed to think.
   */
  readonly model: string
  /** Defaults to `default`: the safe mode, never `bypassPermissions` by omission (§13). */
  readonly permissionMode?: PermissionModeName
  /** Where the peer's worktrees are made (§9). Defaults to the profile's first repo. */
  readonly repo?: string
}

/** What the PR gate and the tracker integration point at (§10). */
export interface RepoProfile {
  readonly repo: string
}

export interface Profile {
  /** The profile's own name; must match the file it was read from (§2). */
  readonly profile: string
  /** Repos the fleet may assign work in; the first is the default (§5.2). */
  readonly repos: readonly string[]
  readonly peers: readonly PeerProfile[]
  /** §6's per-routine settings, handed to `planRoutines` unchanged. */
  readonly routines?: RoutinesConfig
  /** §6.1: where a notification goes. `none` keeps the ledger and sends nothing. */
  readonly notify?: { readonly channel: 'macos' | 'none' }
  readonly limits?: {
    /** How many sessions may be live at once (§6's `keep-busy` and self-purge). */
    readonly maxSessions?: number
  }
  /** How often the scheduler timer fires. Defaults to 5 s, under the shortest routine period (§6). */
  readonly tickIntervalMs?: number
  /** §10: the user's choice, so the daemon never deletes a branch on its own initiative. */
  readonly deleteMergedBranches?: boolean
}

const peerProfile = (): Schema<PeerProfile> =>
  objectAs<PeerProfile>()({
    id: peerId(),
    role: text(60),
    provider: oneOf(profileProviders),
    model: text(80),
    permissionMode: optional(oneOf(permissionModes)),
    repo: optional(text(200)),
  })

/**
 * Routines are passed through undecoded: `planRoutines` already refuses an
 * unknown kind with a message that names the ones that exist, and §6's table is
 * its business, not the profile reader's.
 */
const routinesBlock = (): Schema<RoutinesConfig> => ({
  tag: 'RoutinesConfig',
  decode: (value, path, issues) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ path, message: 'must be a mapping of routine kind to settings' })
      return {} as RoutinesConfig
    }
    return value as RoutinesConfig
  },
})

const notifyBlock = (): Schema<{ readonly channel: 'macos' | 'none' }> =>
  objectAs<{ readonly channel: 'macos' | 'none' }>()({ channel: oneOf(['macos', 'none'] as const) })

const limitsBlock = (): Schema<{ readonly maxSessions?: number }> =>
  objectAs<{ readonly maxSessions?: number }>()({ maxSessions: optional(positiveInt()) })

export const profileSchema = (): Schema<Profile> =>
  objectAs<Profile>()({
    profile: text(60),
    repos: array(text(200), { maxItems: 50 }),
    peers: array(peerProfile(), { maxItems: 50 }),
    routines: optional(routinesBlock()),
    notify: optional(notifyBlock()),
    limits: optional(limitsBlock()),
    tickIntervalMs: optional(positiveInt()),
    deleteMergedBranches: optional(boolean()),
  })

/**
 * Decode a parsed YAML value. Strict: an unknown key is refused here, because a
 * profile is hand-written and a typo in it is silent otherwise.
 */
export const decodeProfile = (value: unknown): Profile => parseStrict(profileSchema(), value)

/**
 * Read and decode the profile file. The name check is two-way on purpose: a file
 * named `engineer.yaml` that says `profile: devops` is two fleets in one
 * directory, and the daemon should say so rather than pick one.
 */
export const loadProfile = async (file: string, expectedName: string): Promise<Profile> => {
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch (cause) {
    throw fleetError('not_found', `no profile at ${file}; \`fleet init ${expectedName}\` writes a starter one`, {
      cause,
    })
  }

  let parsed: unknown
  try {
    parsed = parseYaml(source)
  } catch (cause) {
    throw fleetError('invalid_input', `${file} is not valid YAML: ${(cause as Error).message}`, { cause })
  }

  const profile = decodeProfile(parsed)
  if (profile.profile !== expectedName) {
    throw fleetError(
      'invalid_input',
      `${file} says \`profile: ${profile.profile}\`, but it was read as "${expectedName}"; rename the file or fix the field`,
    )
  }
  if (profile.peers.length === 0) {
    throw fleetError('invalid_input', `${file} declares no peers, so the fleet would have nothing to run`)
  }
  const ids = new Set(profile.peers.map((peer) => peer.id))
  if (ids.size !== profile.peers.length) {
    throw fleetError('invalid_input', `${file} declares the same peer id twice`)
  }
  return profile
}
