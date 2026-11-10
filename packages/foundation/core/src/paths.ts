/**
 * Where a profile's files live (architecture §2, "On disk").
 *
 * Two roots, decided 2026-11-10 and worth keeping apart:
 *
 * - `~/.config/fleet/profiles/<profile>.yaml` is the *user's* profile — hand
 *   written, reviewed, backed up with dotfiles.
 * - `~/.fleet/<profile>/` is what the fleet *produces* — the store, the socket,
 *   the pid, the log, transcripts, artifacts. Deleting it loses history, never
 *   configuration.
 *
 * Every path here is derived, never guessed at a call site: a test passes its
 * own roots and gets the same layout, so nothing that reads this file touches
 * `HOME` by accident.
 *
 * It lives in `foundation/core` rather than in `apps/daemon` because more than
 * one app needs it — `fleetd` to open the store and `fleet` to find the socket
 * to talk to it — and §1.1 forbids one app importing another. Two layouts, one
 * per app, would be two fleets on disk.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { fleetError } from './errors.ts'

/** The profile name: what names the YAML file and the state directory. */
export type ProfileName = string

/** `^[a-z][a-z0-9-]*$`: a name that is safe as a file name and readable in a socket path. */
const PROFILE_NAME = /^[a-z][a-z0-9-]*$/

export interface PathRoots {
  /** `~` by default; a test points it at a temp directory. */
  readonly home?: string
  /** `$XDG_CONFIG_HOME`, `~/.config` by default. */
  readonly configHome?: string
}

export interface ProfilePaths {
  readonly profile: ProfileName
  /** `$XDG_CONFIG_HOME`, `~/.config` by default: where profiles, and their secrets, live. */
  readonly configHome: string
  /** `~/.config/fleet/profiles/<profile>.yaml` — the file `fleet up` reads. */
  readonly profileFile: string
  /** `~/.fleet/<profile>/`. */
  readonly stateDir: string
  /** `store/store.sqlite`; the `-wal` and `-shm` files live beside it (§3). */
  readonly storePath: string
  /** `store/backup/` — the nightly copy (§1.1). */
  readonly backupDir: string
  /** `daemon/` — the socket, the pid and the log. */
  readonly daemonDir: string
  readonly socketPath: string
  readonly pidPath: string
  /** `daemon/fleetd.lock` — the pid lock one live fleetd holds on the store. */
  readonly lockPath: string
  readonly logPath: string
  /** `peers/<peerId>/state.md` (§8). */
  readonly peersDir: string
  /** `transcripts/<peerId>/<sessionId>.jsonl` (§4). */
  readonly transcriptsDir: string
  /** `artifacts/` — scanner output and build logs (§6.2, §11). */
  readonly artifactsDir: string
  /** `notify/<key>.json` — delivered-notification receipts (§6.1). */
  readonly notifyDir: string
}

/**
 * A profile name becomes a path, so it is refused rather than sanitised: a name
 * with a `/` or `..` in it would put the store somewhere else, and a fleet that
 * silently accepted `../..` is a fleet that writes outside its own directory.
 */
export const parseProfileName = (name: string): ProfileName => {
  if (!PROFILE_NAME.test(name)) {
    throw fleetError(
      'invalid_input',
      `profile "${name}" is not a valid name: it must match ${PROFILE_NAME.source} (lowercase letters, digits and dashes, starting with a letter)`,
    )
  }
  return name
}

export const profilePaths = (profile: ProfileName, roots: PathRoots = {}): ProfilePaths => {
  const name = parseProfileName(profile)
  const home = roots.home ?? homedir()
  const configHome = roots.configHome ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config')
  const stateDir = join(home, '.fleet', name)
  const daemonDir = join(stateDir, 'daemon')
  return {
    profile: name,
    configHome,
    profileFile: join(configHome, 'fleet', 'profiles', `${name}.yaml`),
    stateDir,
    storePath: join(stateDir, 'store', 'store.sqlite'),
    backupDir: join(stateDir, 'store', 'backup'),
    daemonDir,
    socketPath: join(daemonDir, 'fleetd.sock'),
    pidPath: join(daemonDir, 'fleetd.pid'),
    lockPath: join(daemonDir, 'fleetd.lock'),
    logPath: join(daemonDir, 'fleetd.log'),
    peersDir: join(stateDir, 'peers'),
    transcriptsDir: join(stateDir, 'transcripts'),
    artifactsDir: join(stateDir, 'artifacts'),
    notifyDir: join(stateDir, 'notify'),
  }
}

/** The directories `up` creates before it opens anything (§2). Idempotent: `mkdir -p`. */
export const persistentDirs = (paths: ProfilePaths): readonly string[] => [
  join(paths.stateDir, 'store'),
  paths.backupDir,
  paths.daemonDir,
  paths.peersDir,
  paths.transcriptsDir,
  paths.artifactsDir,
  join(paths.artifactsDir, 'findings'),
  join(paths.artifactsDir, 'builds'),
  paths.notifyDir,
]
