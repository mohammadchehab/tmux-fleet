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
  literal,
  number,
  objectAs,
  oneOf,
  optional,
  parseStrict,
  peerId,
  positiveInt,
  record,
  refine,
  SchemaError,
  string,
  text,
  unionAs,
  type Schema,
} from '@fleet/foundation-core'
import type { PeerId } from '@fleet/foundation-core'
import {
  effort as effortSchema,
  profileProviders,
  routineKinds,
  workStates,
  type Effort,
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
   * Either this or the peer's role must declare one (see `roles`) — refused at
   * load when neither does, because `peer.registered` carries a concrete model
   * and a fallback would be the daemon inventing a policy for how much this peer
   * is allowed to think. Naming it here wins over the role's (TASK-12).
   */
  readonly model?: string
  /**
   * The reasoning level the session starts on (TASK-12). Peer first, then the
   * role's; absent in both means the provider's own default, unsaid. A provider
   * whose `capabilities.effort` is false cannot honour this, and `fleet up` warns
   * naming the peer rather than starting a session that quietly is not it.
   */
  readonly effort?: Effort
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

/**
 * What a role declares for the peers that fill it (TASK-12): the model and the
 * reasoning level they start on. Both optional, so a role can set a house model
 * without having an opinion about effort.
 *
 * This is a *profile* default, not a daemon one: it is written down by the user
 * in the same file, which is what keeps `PeerProfile.model`'s precedent — that
 * nothing invents how much a peer may think — intact. A peer that names its own
 * model or effort wins over its role's; what is refused is a peer whose model
 * nothing names (see `modelFor`).
 */
export interface RoleProfile {
  readonly model?: string
  readonly effort?: Effort
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

/**
 * The `cursor` block. It exists for one reason: the CLI reports no context
 * window, so a fleet has to state one before a cursor peer can run (§8). A peer
 * whose model is not here is refused at `fleet up` by the adapter, rather than
 * handed a guessed window and purged at a fraction of the context it had.
 *
 * Cursor authenticates the CLI on the machine (`cursor-agent login`), so on a
 * logged-in machine there is no key to configure. A machine that is not logged in
 * (a headless box) names where the key lives with `tokenEnv` / `tokenFile` — a
 * reference, never the key itself, as for DeepInfra (TASK-24); with neither the
 * route is off. Being read-only is not a setting: the adapter honours `plan`
 * mode only, whatever a peer's profile says.
 */
export interface CursorProfile {
  /**
   * The variable in **fleetd's own** environment that holds the key; defaults to
   * `CURSOR_API_KEY` when only `tokenFile` is named. Naming either turns the
   * route on.
   */
  readonly tokenEnv?: string
  /** The file to read the key from when the variable yields nothing: its **first line**. No default. */
  readonly tokenFile?: string
  /**
   * The context window per cursor model id, in tokens. Keys are the ids
   * `cursor-agent models` prints, which is what a peer's `model` must name too.
   */
  readonly contextLimits?: Readonly<Record<string, number>>
}

/** The provider blocks this build reads; a provider with no block uses its defaults. */
export interface ProvidersProfile {
  readonly deepinfra?: DeepInfraProfile
  readonly cursor?: CursorProfile
}

/**
 * §5.3: who answers the Judge's questions.
 *
 * The Judge is a *provider path*, not a peer (§4 of the §5.3 spike): one
 * schema-constrained call, same child-env allowlist as a session, same model
 * ids. Before this block existed the daemon built that call with no env at all,
 * so it ran on fleetd's ambient identity — a machine with no Claude login
 * answered `subtype: success` with no structured output and every `thin_card`
 * escalated forever, and a machine *with* one silently ran as whoever that
 * login was (§14.1's env drift, inside the Judge).
 *
 * Naming it here is what makes the answering model a decision instead of an
 * accident. `provider` decides where the call goes and therefore which env it
 * is given; `model` must be an id that provider serves — a DeepSeek id on
 * `claude` is refused at `fleet up` by the adapter, `cursor` is refused at load (it has
 * no structured-completion call to answer with), and a `deepinfra` block
 * with no key is a startup error rather than a quiet fall back to the machine.
 *
 * Absent, the Judge keeps its old behaviour: the cheap default model on
 * whatever identity fleetd happens to have. That is the honest default for a
 * machine that *is* logged in, and `fleet doctor`'s job to warn about — but a
 * fleet that cares which model judges its work should say so.
 */
export interface JudgeProfile {
  readonly provider: ProfileProvider
  readonly model: string
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
  /**
   * Whether a peer's note may be mirrored to this board as a comment: `true`
   * turns `work.noted` into `Tracker.comment`, and **absent means no**.
   *
   * Off by default because a board is not necessarily ours. A `blocked` note
   * still raises its Decision either way — that path is internal — but a note is
   * peer-written prose, and posting it automatically into a customer's Jira is a
   * disclosure the fleet does not get to make on the user's behalf. A profile
   * that wants the mirroring says so, per board.
   */
  readonly comments?: boolean
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

/** §11's two hosts. `remote` exists only when the profile names a box to reach. */
export const profileBuildHosts = ['local', 'remote'] as const
export type ProfileBuildHost = (typeof profileBuildHosts)[number]

/**
 * §11, as a profile writes it: where light work runs, which task classes are
 * heavy, and how to reach the box they run on.
 *
 * A class is the text before a task's first `:` — `evals` covers every suite and
 * every model, which is the point of routing by class. The block is optional;
 * without it every build runs locally, because a fleet that has not named a
 * remote host should still record its builds.
 */
export interface ProfileBuilds {
  /** Where a task that is not heavy runs. Defaults to `local`. */
  readonly host?: ProfileBuildHost
  /** Task classes that go to the remote host. Empty (or absent) means "nothing is heavy". */
  readonly heavy?: readonly string[]
  /** Kill a build that runs longer than this many minutes. Absent takes the ledger's default (an hour). */
  readonly timeoutMinutes?: number
  /** The remote host. Required for a `heavy` class to mean anything: the daemon refuses the combination. */
  readonly remote?: {
    /** The `ssh` target: a host, or a `~/.ssh/config` alias such as `hetzner`. */
    readonly target: string
    /** Where checkouts live on that host; one directory per repo below it. */
    readonly root: string
    /** The repo's remote as `git` sees it there. Defaults to `origin`. */
    readonly remote?: string
  }
}

/**
 * §12.1: what every peer is held to, beyond what the target repo's own
 * `AGENTS.md` and `CLAUDE.md` already say (those are read from the repo's default
 * branch, never configured here).
 *
 * Both keys name documents by path: absolute, or relative to the directory the
 * profile file is in — never to a repo or a peer's worktree, which a peer can
 * edit. Declared means required: a document that cannot be read refuses the
 * daemon's start with the key named, because a rule that goes missing without a
 * word is how a peer writes off-standard code. Neither document is ever cut: one
 * over the size a peer carries is refused, so the profile's author shortens it.
 */
export interface StandardsProfile {
  /** A document of rules that outrank the repo's own. */
  readonly nonNegotiables?: string
  /**
   * Documents a role must follow, by role — a skill's text, say. They are inlined
   * into the peer's brief rather than named: the claude provider runs with
   * `settingSources: []` and cursor has no skill tool, so a name alone is a
   * sentence a peer cannot act on.
   */
  readonly skills?: Readonly<Record<string, readonly string[]>>
}

export interface Profile {
  /** The profile's own name; must match the file it was read from (§2). */
  readonly profile: string
  /** Repos the fleet may assign work in; the first is the default (§5.2). */
  readonly repos: readonly string[]
  /**
   * Where each repo is checked out on this machine, as an absolute path. A peer
   * with no worktree of its own starts in its repo's checkout, so a peer's
   * session sees that repo's AGENTS.md, CLAUDE.md and skills and not the
   * fleet's state directory. Keys must be in `repos`; a repo with no entry has
   * no checkout, and a peer on it is refused at start rather than started blind.
   */
  readonly checkouts?: Readonly<Record<string, string>>
  /** §12.1: the standards every peer's brief carries. Absent, a peer gets the role statement alone. */
  readonly standards?: StandardsProfile
  readonly peers: readonly PeerProfile[]
  /**
   * TASK-12: model and effort by role, the defaults every peer of that role
   * starts on. A peer's own `model`/`effort` wins; this is what stops a profile
   * repeating the same model on five engineers.
   */
  readonly roles?: Readonly<Record<string, RoleProfile>>
  /** §6's per-routine settings, handed to `planRoutines` unchanged. */
  readonly routines?: RoutinesConfig
  /**
   * §4: the profile's own policy for the providers this daemon wires. Read only
   * for a provider a peer actually names — the same rule `buildProviders` uses
   * to decide what to construct.
   */
  readonly providers?: ProvidersProfile
  /** §5.3: who answers the Judge's questions. Absent, the cheap default on fleetd's own identity. */
  readonly judge?: JudgeProfile
  /** §10: which forge the fleet's repos live on, and its host. Absent means `github.com`. */
  readonly forge?: ForgeProfile
  /** §6.1: where a notification goes. `none` keeps the ledger and sends nothing. */
  readonly notify?: { readonly channel: 'macos' | 'none' }
  /**
   * §6.1: the soft spend cap, in USD. Absent means the fleet never asks about money — a default cap would put a
   * question in every profile's inbox, so it has to be written down. The question is raised once per value (see
   * `budgetDecisionId`), so raising it here is also how the user says "carry on".
   */
  readonly budget?: { readonly usd: number }
  /**
   * §6.2: the scanners to run. The block's presence is what installs the
   * `security-scan` routine — a profile without it scans nothing, and scans
   * nothing silently, which is the honest default for a tool that spawns three
   * programs on every PR.
   */
  readonly security?: { readonly scanners: readonly ProfileScanner[] }
  /**
   * §11: what a build runs on, and which tasks are heavy. Absent means one local
   * host and nothing heavy — the ledger still records every build.
   */
  readonly builds?: ProfileBuilds
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
  /**
   * shared-fleet.md §6: the project this fleet pools its budget with. Absent,
   * the fleet is on its own and talks to no coordination repository.
   */
  readonly coord?: CoordProfile
}

/**
 * A shared fleet's project (shared-fleet.md §2, §6, §9): one private repository
 * per project, because GitHub grants access per repository and not per ref — a
 * repository two projects shared would show each one's team the other's fleets.
 * So the repository is the boundary, and nothing inside it needs a namespace.
 */
export interface CoordProfile {
  /** `<org>/<repo>`: the project's private coordination repository. */
  readonly repo: string
  /** `<org>/<team>`: the GitHub team that is the project's membership, and its access to `repo`. */
  readonly team: string
  /**
   * This fleet's GitHub login, which names its branch. Absent, it is read from
   * `gh` at `fleet up`, so nobody types it — but a machine with two accounts says
   * which one here.
   */
  readonly user?: string
  /**
   * §9: whether task data is shared. Only `false` exists in this build: `true`
   * needs Legal sign-off (§7, finding 2), and nothing here would honour it.
   */
  readonly taskData?: false
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

/**
 * The `roles` block (TASK-12), decoded the way it is written: one entry per role
 * name. Role names are not a closed set — `role` on a peer is free text, because
 * a fleet's org chart is its own — so the key is a name, and a `roles` entry no
 * peer fills is simply unused rather than an error (a profile may plan ahead for
 * a role it has not hired yet).
 */
const rolesBlock = (): Schema<Readonly<Record<string, RoleProfile>>> =>
  record(
    objectAs<RoleProfile>()({
      model: optional(text(80)),
      effort: optional(effortSchema()),
    }),
  )

const peerProfile = (): Schema<PeerProfile> =>
  objectAs<PeerProfile>()({
    id: peerId(),
    role: text(60),
    provider: oneOf(profileProviders),
    model: optional(text(80)),
    effort: optional(effortSchema()),
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

const ORG_SLASH_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/

const coordBlock = (): Schema<CoordProfile> =>
  objectAs<CoordProfile>()({
    repo: string({ pattern: ORG_SLASH_NAME, maxLength: 200 }),
    team: string({ pattern: ORG_SLASH_NAME, maxLength: 200 }),
    user: optional(string({ pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/ })),
    taskData: optional(literal(false)),
  })

/** A cap of 0 would ask the moment the first turn is billed; it is a number, but not a budget. */
const budgetBlock = (): Schema<{ readonly usd: number }> =>
  objectAs<{ readonly usd: number }>()({
    usd: refine(number({ min: 0 }), (value) => value > 0, 'a budget in USD above zero'),
  })

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

const cursorBlock = (): Schema<CursorProfile> =>
  objectAs<CursorProfile>()({
    contextLimits: optional(record(positiveInt())),
    tokenEnv: optional(text(120)),
    tokenFile: optional(text(400)),
  })

/**
 * Both fields are required: a `judge:` block that names a provider and leaves
 * the model to the default is the failure this block exists to prevent — the
 * default is a Claude id, and a fleet whose peers are on DeepInfra would then
 * send a Claude id to DeepInfra and get a model-not-found back per question.
 */
const judgeBlock = (): Schema<JudgeProfile> =>
  objectAs<JudgeProfile>()({
    // Not every provider a peer can run on can answer a Judge question. The transport is
    // one schema-constrained completion through the Claude SDK, which `claude` and
    // `deepinfra` (its Anthropic-compatible endpoint) both serve; `cursor` is a read-only
    // agent CLI with no such call. Accepting it would send a cursor model id to the SDK on
    // fleetd's own login and call that "the profile's judge", so it is refused here.
    provider: refine(
      oneOf(profileProviders),
      (provider) => provider !== 'cursor',
      'claude or deepinfra: the Judge answers through the Claude SDK, which cursor cannot',
    ),
    model: text(80),
  })

const providersBlock = (): Schema<ProvidersProfile> =>
  objectAs<ProvidersProfile>()({ deepinfra: optional(deepInfraBlock()), cursor: optional(cursorBlock()) })

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
/**
 * §11's block. A task class is the text before a task's first `:` (`task.ts`),
 * so a class containing one would be a class no task could ever have: refused at
 * load rather than silently routing nothing.
 */
const buildClass = (): Schema<string> =>
  refine(
    text(40),
    (value) => value.length > 0 && !value.includes(':') && !value.includes(' '),
    'a task class: the text before a task\'s first ":", with no spaces',
  )

const remoteBuildBlock = (): Schema<NonNullable<ProfileBuilds['remote']>> =>
  objectAs<NonNullable<ProfileBuilds['remote']>>()({
    target: text(200),
    // An absolute path: a relative root would put each build's checkout
    // wherever the remote shell happened to start, which is not a directory
    // anyone can find again.
    root: refine(text(400), (value) => value.startsWith('/'), 'an absolute path on the remote host'),
    remote: optional(text(120)),
  })

const buildsBlock = (): Schema<ProfileBuilds> =>
  objectAs<ProfileBuilds>()({
    host: optional(oneOf(profileBuildHosts)),
    heavy: optional(array(buildClass(), { maxItems: 20 })),
    timeoutMinutes: optional(positiveInt()),
    remote: optional(remoteBuildBlock()),
  })

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
  // Absent is off. See `TrackerProfileBase.comments`: the fleet does not post a
  // peer's prose to a board, least of all a customer's, unless told to.
  comments: optional(boolean()),
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

const standardsBlock = (): Schema<StandardsProfile> =>
  objectAs<StandardsProfile>()({
    nonNegotiables: optional(text(400)),
    skills: optional(record(array(text(400), { maxItems: 30 }))),
  })

export const profileSchema = (): Schema<Profile> =>
  objectAs<Profile>()({
    profile: text(60),
    repos: array(text(200), { maxItems: 50 }),
    checkouts: optional(record(refine(text(400), (value) => value.startsWith('/'), 'an absolute path'))),
    standards: optional(standardsBlock()),
    peers: array(peerProfile(), { maxItems: 50 }),
    roles: optional(rolesBlock()),
    routines: optional(routinesBlock()),
    providers: optional(providersBlock()),
    judge: optional(judgeBlock()),
    forge: optional(forgeBlock()),
    notify: optional(notifyBlock()),
    budget: optional(budgetBlock()),
    security: optional(securityBlock()),
    builds: optional(buildsBlock()),
    trackers: optional(trackerBlock()),
    limits: optional(limitsBlock()),
    tickIntervalMs: optional(positiveInt()),
    deleteMergedBranches: optional(boolean()),
    coord: optional(coordBlock()),
  })

/** The `roles` entry a peer's role names, if the profile has one (TASK-12). */
const roleOf = (
  profile: Pick<Profile, 'roles'>,
  peer: { readonly role: string },
): RoleProfile | undefined => profile.roles?.[peer.role]

/**
 * The model a peer starts on: its own, then its role's (TASK-12's precedence
 * `peer > role > refuse`). Refused rather than defaulted, because a model is the
 * one thing `peer.registered` cannot be allowed to leave unsaid.
 *
 * The refusal names *both* places the model could have been written, because a
 * message that says only "peer engineer-3 has no model" leaves the reader to
 * guess whether the fix was the peer or a `roles` block they may not have heard of.
 */
export const modelFor = (
  profile: Pick<Profile, 'roles'>,
  peer: { readonly id: PeerId; readonly role: string; readonly model?: string },
): string => {
  const model = peer.model ?? roleOf(profile, peer)?.model
  if (model === undefined) {
    throw fleetError(
      'invalid_input',
      `peer '${peer.id}' declares no model and its role '${peer.role}' declares none: add \`model\` to that peer, or a \`roles: { ${peer.role}: { model: … } }\` block`,
    )
  }
  return model
}

/**
 * The reasoning level a peer starts on: its own, then its role's, then none —
 * absent means the provider's default, which is a real answer and not a gap
 * (TASK-12). Whether the provider can honour it is not this function's business;
 * see `effortWarnings`.
 */
export const effortFor = (profile: Profile, peer: PeerProfile): Effort | undefined =>
  peer.effort ?? roleOf(profile, peer)?.effort

/**
 * Decode a parsed YAML value. Strict: an unknown key is refused here, because a
 * profile is hand-written and a typo in it is silent otherwise.
 */
export const decodeProfile = (value: unknown): Profile => {
  const profile = parseStrict(profileSchema(), value)
  // Decoded here rather than at the first session: a purge threshold out of
  // range is a profile mistake, and the profile is what this function is for.
  purgeLimitsOf(profile)
  // A checkout for a repo the profile does not list is a typo, and a typo here
  // would leave the peer on the real repo refused with no hint why.
  for (const repo of Object.keys(profile.checkouts ?? {})) {
    if (!profile.repos.includes(repo)) {
      throw fleetError('invalid_input', `checkouts names '${repo}', which is not in repos: ${profile.repos.join(', ')}`)
    }
  }
  // Every peer's model resolves here, not at the first session: a `roles` block
  // that forgot a role is a profile mistake, and finding it at `fleet up` is the
  // difference between a refused profile and a peer that dies on start (TASK-12).
  for (const peer of profile.peers) modelFor(profile, peer)
  return profile
}

/**
 * What the profile asked for that a peer's provider cannot honour (TASK-12).
 *
 * Effort is the whole set today, and it stays a warning rather than a refusal:
 * the peer is otherwise perfectly startable, the model is right, and a fleet
 * that refuses to start over a reasoning level would be stricter than the
 * profile's own author. But it must not be silent — a session that quietly runs
 * at the provider's default is the profile lying to the person who wrote it.
 */
export const effortWarnings = (
  profile: Profile,
  capabilitiesOf: (provider: ProfileProvider) => { readonly effort: boolean } | undefined,
): readonly string[] => {
  const warnings: string[] = []
  for (const peer of profile.peers) {
    const effort = effortFor(profile, peer)
    if (effort === undefined) continue
    const capabilities = capabilitiesOf(peer.provider)
    if (capabilities === undefined || capabilities.effort) continue
    warnings.push(
      `peer '${peer.id}' asks for effort '${effort}', but provider '${peer.provider}' cannot honour it: the session starts at that provider's own default`,
    )
  }
  return warnings
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
  if (profile.coord !== undefined && profile.budget === undefined) {
    // shared-fleet.md §3: a fleet's pace is its spend against its cap, and a fleet
    // with no cap would have no pace to publish — it would sit in the pool
    // looking like it never spends.
    throw fleetError('invalid_input', `${file} has a \`coord\` block but no \`budget\`; a shared fleet publishes its pace against \`budget.usd\``)
  }
  const ids = new Set(profile.peers.map((peer) => peer.id))
  if (ids.size !== profile.peers.length) {
    throw fleetError('invalid_input', `${file} declares the same peer id twice`)
  }
  return profile
}
