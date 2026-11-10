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
  number,
  objectAs,
  oneOf,
  optional,
  parseStrict,
  peerId,
  positiveInt,
  refine,
  SchemaError,
  text,
  unionAs,
  type Schema,
} from '@fleet/foundation-core'
import type { PeerId } from '@fleet/foundation-core'
import {
  profileProviders,
  routineKinds,
  workStates,
  type ProfileProvider,
  type WorkState,
} from '@fleet/foundation-contracts'
import { checkPurgeLimits, defaultPurgeLimits, type PurgeLimits } from '@fleet/runtime-supervisor'
import {
  jiraSearchFlavors,
  type JiraSearchFlavor,
} from '@fleet/integrations-trackers-jira'
import { parse as parseYaml } from 'yaml'
import type { RoutineSettings, RoutinesConfig } from '@fleet/orchestration-routines'

export { profileProviders, type ProfileProvider }

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
  /**
   * What this model costs to read a token, so a compaction can be reported with
   * a number instead of a shrug (§8). Absent, a compaction is still recorded and
   * flagged — the cost is simply left out, because a vendor's price list is not
   * the fleet's to invent and an estimate of zero would read as free.
   */
  readonly pricing?: PeerPricing
}

/** A price, in the unit a vendor publishes it: US dollars per million input tokens. */
export interface PeerPricing {
  readonly inputUsdPerMillion: number
}

/** What the PR gate and the tracker integration point at (§10). */
export interface RepoProfile {
  readonly repo: string
}

/**
 * What a profile may say about the DeepInfra adapter (§4). The block is the
 * fleet's own policy for that endpoint, so it is enforced in the adapter — which
 * means `setModel` obeys it too, not only the models a peer starts on.
 */
export interface DeepInfraProfile {
  /**
   * The DeepInfra model ids this fleet may run. When present, a peer whose model
   * is off the list is refused at `fleet up` with the adapter's `config_mismatch`
   * rather than reaching DeepInfra and being billed for a model nobody chose.
   * Absent, any model with a configured context window is allowed, as before.
   */
  readonly allowedModels?: readonly string[]
  /**
   * The endpoint, when this fleet runs a proxy or a staging host. Peers on
   * DeepInfra must then be built with the same one: the adapter refuses a spec
   * that names any other.
   */
  readonly baseUrl?: string
  /**
   * The variable in **fleetd's own** environment that holds the key. Defaults to
   * `DEEPINFRA_API_KEY`, and is read at each session start, so a rotated key
   * takes effect on the next start without restarting the daemon.
   *
   * Nothing here ever holds the key itself: a profile is a file in the repo's
   * reach, and a token in it would be a token in `git status`.
   */
  readonly tokenEnv?: string
  /**
   * The file to read the key from when `tokenEnv` is unset or empty: its **first
   * line**, trailing whitespace trimmed. Defaults to `$XDG_CONFIG_HOME/deepinfra/key`
   * — `~/.config/deepinfra/key` — which is where v1 kept it, so an existing
   * machine keeps working.
   */
  readonly tokenFile?: string
}

/** The provider blocks this build reads; a provider with no block uses its defaults. */
export interface ProvidersProfile {
  readonly deepinfra?: DeepInfraProfile
}

/** §10: the forges this build has a `PullRequests` adapter for. */
export const profileForges = ['github', 'gitlab'] as const
export type ProfileForge = (typeof profileForges)[number]

/**
 * §10: which forge a fleet's repos live on. GitHub is the default when the block
 * is absent, because it is what every fleet before this one was.
 *
 * `host` is the forge's own hostname and only GitLab reads it: `glab` resolves a
 * host from the current directory's git remote or from its own config, and the
 * daemon writes worktrees in places neither describes, so a self-hosted forge has
 * to be named here. Absent means the forge's public host (`github.com`,
 * `gitlab.com`).
 */
export interface ForgeProfile {
  readonly kind: ProfileForge
  readonly host?: string
}

/** §3's trackers this daemon can wire up today. A profile names one. */
export const profileTrackerSystems = ['backlog', 'jira'] as const
export type ProfileTrackerSystem = (typeof profileTrackerSystems)[number]

/**
 * §3's board, as a profile declares it: a **source and a sink**, never the state
 * of the fleet. A card is read into a `Work` (`Work.external` names it from then
 * on) and the Work's own transitions are written back, but the fleet's state
 * stays in the store — a profile that pointed at a board would be a second
 * source of truth for something the log already owns.
 *
 * The poll's period is not here: it is `routines.tracker-sync.everyMinutes`,
 * because when a routine runs is the scheduler's business and a second spelling
 * of it would be a second answer.
 *
 * What a board needs depends on which board it is — a Backlog.md project is a
 * directory on disk, a Jira site is a URL and a credential — so the type is a
 * union rather than one shape with every field optional. A profile is then
 * refused for naming another system's keys, instead of half-configuring both.
 */
interface TrackerProfileBase {
  /**
   * The board's own query, handed to `Tracker.pull` unchanged. Each adapter
   * documents its dialect: for Backlog.md it is the statuses to read, comma
   * separated (`"To Do,In Progress"`); for Jira it is JQL.
   */
  readonly query: string
  /**
   * `WorkState` → the board's status. A state the profile omits is left alone:
   * the fleet has no opinion about the tracker's vocabulary, and inventing a
   * column would rewrite a board nobody asked it to touch.
   */
  readonly statuses?: Partial<Record<WorkState, string>>
  /** The role a Work proposed from a card asks for (§5.2's `assign`). */
  readonly role?: string
}

/** A Backlog.md board: markdown files in a directory, read and written by its CLI. */
export interface BacklogTrackerProfile extends TrackerProfileBase {
  readonly system: 'backlog'
  /** The project directory the CLI runs in. Backlog.md keeps a board per directory. */
  readonly path: string
  /** A prefix a card's path becomes a URL under — a repo's blob URL, typically. */
  readonly urlBase?: string
}

/**
 * Where a Jira site's credential is read from — never the credential itself.
 * The rule `DeepInfraProfile` states holds for every provider: a profile is a
 * file in the repo's reach, and a token in it would be a token in `git status`.
 * `jira-env.ts` resolves these into the token the adapter is handed at compose.
 */
export interface JiraCredentialProfile {
  /**
   * The variable in **fleetd's own** environment that holds the token. Defaults
   * per `kind` — `JIRA_API_TOKEN` for Cloud, `JIRA_PAT` for Server / Data
   * Center — because the two kinds are issued by different systems and one
   * machine may hold both.
   */
  readonly tokenEnv?: string
  /** The file to read the token from when `tokenEnv` yields nothing: its **first line**. */
  readonly tokenFile?: string
}

/** Cloud: `email` names the account its API token was issued for. */
export interface JiraCloudAuthProfile extends JiraCredentialProfile {
  readonly kind: 'cloud'
  readonly email: string
}

/** Server / Data Center: one personal access token, already an identity, so no email half. */
export interface JiraPatAuthProfile extends JiraCredentialProfile {
  readonly kind: 'pat'
}

export type JiraAuthProfile = JiraCloudAuthProfile | JiraPatAuthProfile

/** A Jira site: REST v3 over HTTPS, in whichever flavour its release serves. */
export interface JiraTrackerProfile extends TrackerProfileBase {
  readonly system: 'jira'
  /** The site, e.g. `https://acme.atlassian.net`. The credential is never part of it. */
  readonly baseUrl: string
  /**
   * Which of the two credentials this install issues, and where the token is
   * read from. A block that writes the token down instead is refused as an
   * unknown field rather than quietly accepted — `jira-env.ts` says why.
   */
  readonly auth: JiraAuthProfile
  /**
   * Which search endpoint this release serves. Defaults from `auth.kind` — an
   * API token is Cloud's, a PAT is a Server install's — and is named only for a
   * release where the two disagree (the adapter's `tracker.ts` says why).
   */
  readonly search?: JiraSearchFlavor
}

export type TrackerProfile = BacklogTrackerProfile | JiraTrackerProfile

/** §6.2's tools, as a profile may name them: the four adapters this daemon ships. */
export const profileScanners = ['semgrep', 'gitleaks', 'osv-scanner', 'trivy'] as const
export type ProfileScanner = (typeof profileScanners)[number]

export interface Profile {
  /** The profile's own name; must match the file it was read from (§2). */
  readonly profile: string
  /** Repos the fleet may assign work in; the first is the default (§5.2). */
  readonly repos: readonly string[]
  readonly peers: readonly PeerProfile[]
  /** §6's per-routine settings, handed to `planRoutines` unchanged. */
  readonly routines?: RoutinesConfig
  /**
   * §4: the profile's own policy for the providers this daemon wires. Read only
   * for a provider a peer actually names — the same rule `buildProviders` uses
   * to decide what to construct.
   */
  readonly providers?: ProvidersProfile
  /** §10: which forge the fleet's repos live on, and its host. Absent means `github.com`. */
  readonly forge?: ForgeProfile
  /** §6.1: where a notification goes. `none` keeps the ledger and sends nothing. */
  readonly notify?: { readonly channel: 'macos' | 'none' }
  /**
   * §6.2: the scanners to run. The block's presence is what installs the
   * `security-scan` routine — a profile without it scans nothing, and scans
   * nothing silently, which is the honest default for a tool that spawns three
   * programs on every PR.
   */
  readonly security?: { readonly scanners: readonly ProfileScanner[] }
  /**
   * §3: the board to mirror. Its presence is what installs `tracker-sync`, for
   * `security`'s reason — a profile that named no board has nothing to poll, and
   * a routine that silently polled nothing would read as a sync that agreed.
   */
  readonly trackers?: TrackerProfile
  readonly limits?: {
    /** How many sessions may be live at once (§6's `keep-busy` and self-purge). */
    readonly maxSessions?: number
    /**
     * §8: when a session is handed off. Absent fields take the supervisor's
     * defaults (`defaultPurgeLimits`), and the whole block is validated at load,
     * so a ratio of 1.5 is a startup error rather than a fleet that never purges.
     *
     * This exists because the live path had no way to say it: the daemon shipped
     * its own frozen copy of the thresholds, so tuning a purge meant editing and
     * rebuilding the daemon rather than the profile the rest of the fleet is
     * already configured from.
     */
    readonly purge?: ProfilePurgeLimits
  }
  /** How often the scheduler timer fires. Defaults to 5 s, under the shortest routine period (§6). */
  readonly tickIntervalMs?: number
  /** §10: the user's choice, so the daemon never deletes a branch on its own initiative. */
  readonly deleteMergedBranches?: boolean
}

/**
 * A price above zero. Zero is refused because it is almost certainly a typo and
 * it would report every compaction as costing nothing. A fraction is allowed:
 * vendors publish per-million prices like 0.27.
 */
const pricePerMillion = (): Schema<number> =>
  refine(number({ min: 0 }), (value) => value > 0, 'expected a price above zero')

const peerPricing = (): Schema<PeerPricing> =>
  objectAs<PeerPricing>()({ inputUsdPerMillion: pricePerMillion() })

const peerProfile = (): Schema<PeerProfile> =>
  objectAs<PeerProfile>()({
    id: peerId(),
    role: text(60),
    provider: oneOf(profileProviders),
    model: text(80),
    permissionMode: optional(oneOf(permissionModes)),
    repo: optional(text(200)),
    pricing: optional(peerPricing()),
  })

/**
 * One routine's settings (§6): `enabled`, and the two the trigger reads. Every
 * field is optional because naming a routine at all means "run it", and the
 * defaults are the schedule; what a profile says here is the exception.
 */
const routineSettings = (): Schema<RoutineSettings> =>
  objectAs<RoutineSettings>()({
    enabled: optional(boolean()),
    everyMinutes: optional(positiveInt()),
    // The shape is checked here and the value by the scheduler, which owns what
    // a time of day means; `at: 9am` should fail at load either way.
    at: optional(text(5)),
  })

/**
 * The `routines` block, decoded the way it is written: one entry per kind.
 *
 * This used to be a pass-through cast, on the theory that `planRoutines` would
 * refuse anything wrong. It did refuse an unknown kind — but by then the block
 * had been handed on verbatim and the config it was read as nested one level
 * deeper, so `routines: {dispatch: {enabled: false}}` (the spelling in every
 * example) configured nothing and every routine ran. A profile is hand-written
 * and silence here means "on", so a key this reader does not recognise is
 * refused and named: a routine that quietly never ran, or never stopped, is the
 * one failure a settings block must not have.
 */
const routinesBlock = (): Schema<RoutinesConfig> => ({
  tag: 'RoutinesConfig',
  decode: (value, path, issues, mode) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ path, message: 'must be a mapping of routine kind to settings' })
      return {}
    }
    const settings: Record<string, RoutineSettings> = {}
    for (const [kind, block] of Object.entries(value)) {
      if (!(routineKinds as readonly string[]).includes(kind)) {
        issues.push({
          path: `${path}.${kind}`,
          message: `is not a routine; this fleet has ${routineKinds.join(', ')}`,
        })
        continue
      }
      settings[kind] = routineSettings().decode(block, `${path}.${kind}`, issues, mode)
    }
    return settings as RoutinesConfig
  },
})

const notifyBlock = (): Schema<{ readonly channel: 'macos' | 'none' }> =>
  objectAs<{ readonly channel: 'macos' | 'none' }>()({ channel: oneOf(['macos', 'none'] as const) })

/**
 * An empty allowlist is refused for the same reason an empty scanner set is: it
 * is a block that reads as configured and then permits nothing, so every peer on
 * that provider would fail at `fleet up` with no hint that the list was the bug.
 */
const deepInfraBlock = (): Schema<DeepInfraProfile> =>
  objectAs<DeepInfraProfile>()({
    allowedModels: optional(
      refine(
        array(text(120), { maxItems: 50 }),
        (models) => models.length > 0,
        'at least one model when the list is given',
      ),
    ),
    baseUrl: optional(text(300)),
    // Names, not values: a profile says *where* the key is, and the daemon is
    // the thing that reads it. A path long enough for a real one, short enough
    // that a pasted key is refused rather than silently ignored.
    tokenEnv: optional(text(120)),
    tokenFile: optional(text(400)),
  })

const providersBlock = (): Schema<ProvidersProfile> =>
  objectAs<ProvidersProfile>()({ deepinfra: optional(deepInfraBlock()) })

const forgeBlock = (): Schema<ForgeProfile> =>
  objectAs<ForgeProfile>()({
    kind: oneOf(profileForges),
    // A hostname, not a URL: `GITLAB_HOST` takes `gitlab.example`, and a pasted
    // `https://…` would be a host no `glab` subcommand recognises.
    host: optional(
      refine(
        text(200),
        (host) => !host.includes('/') && !host.includes('://'),
        'a bare hostname, without a scheme or a path',
      ),
    ),
  })

/**
 * `limits.purge`, as a profile writes it. Minutes rather than milliseconds
 * because a profile is read by people, and every key is optional so a profile
 * can tune one threshold without restating the others.
 */
export interface ProfilePurgeLimits {
  /** Purge at this fraction of the configured context window (§8). */
  readonly contextRatio?: number
  /** …or after this many completed turns, for a provider that cannot report context. */
  readonly maxTurns?: number
  /** …or after this long, even if the session has been idle. */
  readonly maxSessionMinutes?: number
}

const purgeLimitsBlock = (): Schema<ProfilePurgeLimits> =>
  objectAs<ProfilePurgeLimits>()({
    // The range is `checkPurgeLimits`' business, not the schema's: one validator
    // for the thresholds, whether they arrived from a file or from a default.
    contextRatio: optional(number({ min: 0 })),
    maxTurns: optional(positiveInt()),
    maxSessionMinutes: optional(positiveInt()),
  })

const limitsBlock = (): Schema<{ readonly maxSessions?: number; readonly purge?: ProfilePurgeLimits }> =>
  objectAs<{ readonly maxSessions?: number; readonly purge?: ProfilePurgeLimits }>()({
    maxSessions: optional(positiveInt()),
    purge: optional(purgeLimitsBlock()),
  })

/**
 * The purge thresholds this profile asks for, over the supervisor's defaults and
 * validated (§8). Every caller that starts a session goes through here, so there
 * is one answer to "when does this fleet hand off" and a typo in it is refused
 * at load rather than discovered by a fleet that never purged.
 *
 * @throws FleetError('invalid_input') when a threshold is out of range.
 */
export const purgeLimitsOf = (profile: Pick<Profile, 'limits'>): PurgeLimits => {
  const asked = profile.limits?.purge
  return checkPurgeLimits({
    ...defaultPurgeLimits,
    ...(asked?.contextRatio === undefined ? {} : { contextRatio: asked.contextRatio }),
    ...(asked?.maxTurns === undefined ? {} : { maxTurns: asked.maxTurns }),
    ...(asked?.maxSessionMinutes === undefined
      ? {}
      : { maxSessionMillis: asked.maxSessionMinutes * 60_000 }),
  })
}

/** An empty list would install the routine and then scan nothing, which reads as coverage it does not have. */
const securityBlock = (): Schema<{ readonly scanners: readonly ProfileScanner[] }> =>
  objectAs<{ readonly scanners: readonly ProfileScanner[] }>()({
    scanners: refine(
      array(oneOf(profileScanners), { maxItems: profileScanners.length }),
      (scanners) => scanners.length > 0,
      'at least one scanner',
    ),
  })

/**
 * The status map, decoded by hand so its *keys* are checked against §5.1's
 * states: a misspelt `in_progres` would otherwise be a transition the fleet
 * believes it configured and a board that never sees.
 */
const statusesBlock = (): Schema<Partial<Record<WorkState, string>>> => ({
  tag: 'TrackerStatuses',
  decode: (value, path, issues) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ path, message: 'must be a mapping of work state to the tracker status' })
      return {}
    }
    const statuses: Partial<Record<WorkState, string>> = {}
    for (const [state, status] of Object.entries(value as Record<string, unknown>)) {
      if (!(workStates as readonly string[]).includes(state)) {
        issues.push({ path: `${path}.${state}`, message: `not a work state; the fleet has: ${workStates.join(', ')}` })
        continue
      }
      if (typeof status !== 'string' || status.trim() === '') {
        issues.push({ path: `${path}.${state}`, message: 'must be the tracker\'s status name, not empty' })
        continue
      }
      statuses[state as WorkState] = status
    }
    return statuses
  },
})

/** What both boards read the same way, whichever system they belong to. */
const trackerBase = {
  query: text(500),
  statuses: optional(statusesBlock()),
  role: optional(text(60)),
} as const

const backlogTrackerBlock = (): Schema<BacklogTrackerProfile> =>
  objectAs<BacklogTrackerProfile>()({
    system: oneOf(['backlog'] as const),
    ...trackerBase,
    path: text(400),
    urlBase: optional(text(400)),
  })

/**
 * Cloud with an email plus where its API token is read from, or Server/DC with
 * a PAT and the same two sources. Which one is `kind`.
 *
 * There is no `token` key: a profile that carries one is refused as an unknown
 * field. The refusal is the point — a credential pasted into a YAML file is a
 * credential in `git status`, and a silent rename would let the paste stand.
 */
const jiraAuthBlock = (): Schema<JiraAuthProfile> =>
  unionAs<JiraAuthProfile>()([
    objectAs<JiraCloudAuthProfile>()({
      kind: oneOf(['cloud'] as const),
      email: text(200),
      tokenEnv: optional(text(120)),
      tokenFile: optional(text(400)),
    }),
    objectAs<JiraPatAuthProfile>()({
      kind: oneOf(['pat'] as const),
      tokenEnv: optional(text(120)),
      tokenFile: optional(text(400)),
    }),
  ])

const jiraTrackerBlock = (): Schema<JiraTrackerProfile> =>
  objectAs<JiraTrackerProfile>()({
    system: oneOf(['jira'] as const),
    ...trackerBase,
    baseUrl: text(400),
    auth: jiraAuthBlock(),
    search: optional(oneOf(jiraSearchFlavors)),
  })

/**
 * A union rather than two optional halves, so `system` decides which keys are
 * read: a Jira block that also carries `path` is refused, not quietly ignored.
 * `union` reports the member that came closest, so the message names the field
 * the profile actually got wrong.
 */
const trackerBlock = (): Schema<TrackerProfile> =>
  unionAs<TrackerProfile>()([backlogTrackerBlock(), jiraTrackerBlock()])

export const profileSchema = (): Schema<Profile> =>
  objectAs<Profile>()({
    profile: text(60),
    repos: array(text(200), { maxItems: 50 }),
    peers: array(peerProfile(), { maxItems: 50 }),
    routines: optional(routinesBlock()),
    providers: optional(providersBlock()),
    forge: optional(forgeBlock()),
    notify: optional(notifyBlock()),
    security: optional(securityBlock()),
    trackers: optional(trackerBlock()),
    limits: optional(limitsBlock()),
    tickIntervalMs: optional(positiveInt()),
    deleteMergedBranches: optional(boolean()),
  })

/**
 * Decode a parsed YAML value. Strict: an unknown key is refused here, because a
 * profile is hand-written and a typo in it is silent otherwise.
 */
export const decodeProfile = (value: unknown): Profile => {
  const profile = parseStrict(profileSchema(), value)
  // Decoded here rather than at the first session: a purge threshold out of
  // range is a profile mistake, and the profile is what this function is for.
  purgeLimitsOf(profile)
  return profile
}

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
    // The remedy is one command, and naming it is the difference between a
    // person writing YAML from memory and one starting from the starter that
    // already has every field's spelling right.
    throw fleetError(
      'not_found',
      `no profile at ${file}: run fleet init ${expectedName} to write a starter (it names the fleet's repos and its peers), then edit it and run fleet up ${expectedName} again`,
      { cause },
    )
  }

  let parsed: unknown
  try {
    parsed = parseYaml(source)
  } catch (cause) {
    throw fleetError('invalid_input', `${file} is not valid YAML: ${(cause as Error).message}`, { cause })
  }

  let profile: Profile
  try {
    profile = decodeProfile(parsed)
  } catch (cause) {
    // A profile is hand-written, so a schema failure is a typo in it, and the
    // issue list — `routines.dispatchh: is not a routine; …` — is the whole
    // remedy. `SchemaError` is a `RangeError`, so left alone it reaches the
    // user as a stack trace with the sentence buried in it.
    if (!(cause instanceof SchemaError)) throw cause
    throw fleetError('invalid_input', `${file}: ${cause.message}`, { cause })
  }
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
