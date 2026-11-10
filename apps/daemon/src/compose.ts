/**
 * `fleetd`'s entry point (§2): the composition root, and the only file that
 * knows a concrete provider, a concrete store or a concrete supervisor.
 *
 * The order is deliberate and every step is here for a reason:
 *
 * 1. **Paths, then the profile.** A profile is refused before anything is
 *    created, so a typo never leaves an empty state directory behind.
 * 2. **Directories, then the store.** `~/.fleet/<profile>/` is created with the
 *    store's own subdirectory (§2's "On disk").
 * 3. **Providers, then the supervisor.** Concrete providers are constructed
 *    here and handed to the supervisor as a map by id; nothing below this file
 *    names `ClaudeProvider` or `DeepInfraProvider` (§2, §4).
 * 4. **Mailbox, executor, scheduler, server.** Each takes only the ports it
 *    needs (§1.1).
 *
 * Two things a profile may ask for but this build cannot yet deliver are named
 * as such rather than silently replaced: `integrations/github` (the gate's
 * port) and the PM. A daemon composed without a `pullRequests` port has no
 * `merge` executor at all, so a merge action fails with "no executor is wired
 * for 'merge'" instead of pretending.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { systemClock, type Clock } from '@fleet/foundation-core'
import type { ProjectManager, ProviderRegistry, PullRequests } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore, type StoreFactory } from '@fleet/foundation-store'
import type { Notifier } from '@fleet/notify-core'
import { createGate } from '@fleet/orchestration-gate'
import { createProjectManager } from '@fleet/orchestration-pm'
import { createScheduler, installedFactories, type Scheduler } from '@fleet/orchestration-routines'
import { createMailbox } from '@fleet/runtime-mailbox'
import { ClaudeProvider } from '@fleet/runtime-provider-claude'
import { createDeepInfraProvider } from '@fleet/runtime-provider-deepinfra'
import type { Provider } from '@fleet/runtime-provider-sdk'
import { createDaemon, type Daemon } from './daemon.ts'
import { createExecutorRouter, type KindExecutor } from './executor.ts'
import { createNotifyFactory, notifierFor } from './notify.ts'
import { persistentDirs, profilePaths, type PathRoots } from './paths.ts'
import { loadProfile, type Profile } from './profile.ts'
import { createDaemonServer, type DaemonServer } from './server.ts'
import { createSupervisor, type Supervisor } from './sessions.ts'

export interface Wiring {
  readonly profile: Profile
  readonly store: EventStore
  readonly providers: ReadonlyMap<string, Provider>
  readonly clock: Clock
  /** The PM that decides (§5.2); injected until `orchestration/pm` lands. */
  readonly pm: ProjectManager
}

export interface ComposeDeps {
  readonly profileName: string
  readonly roots?: PathRoots
  readonly clock?: Clock
  /** Defaults to the SQLite store `@fleet/foundation-store` ships; a test passes its own. */
  readonly openStore?: StoreFactory['open']
  /** The PM that decides (§5.2). Defaults to `@fleet/orchestration-pm`'s own. */
  readonly pm?: ProjectManager
  /** `integrations/github`, the gate's §10 port. Absent means no `merge`/`retarget` executor. */
  readonly pullRequests?: PullRequests
  /** Providers to construct instead of the built-in set, by the profile's `provider` name. */
  readonly providers?: ReadonlyMap<string, Provider>
  /** Extra executors — the judge, the notifier — one per kind (§5.2). */
  readonly executors?: (wiring: Wiring & { readonly supervisor: Supervisor }) => readonly KindExecutor[]
  /**
   * The channel notifications ring on (§6.1). Defaults to the profile's
   * `notify.channel`: `macos` builds the desktop channel, `none` — or no
   * `notify` block at all — installs no `notify` routine. A test passes its own
   * so a run cannot put a banner on someone's screen.
   */
  readonly notifier?: Notifier
}

export interface Composed {
  readonly daemon: Daemon
  readonly server: DaemonServer
  readonly store: EventStore
  readonly supervisor: Supervisor
  /**
   * Exposed because the daemon reaches it through `DaemonDeps` and a test that
   * composes a real fleet has no other handle on the routines: `fleet ls` shows
   * what ran, not what is installed.
   */
  readonly scheduler: Scheduler
}

/**
 * The providers a profile may name, constructed here and nowhere else (§2).
 * Only the ones a peer actually uses are built: a provider that starts a
 * process or reads a key on construction must not exist because a different
 * profile asked for it.
 */
export const buildProviders = (profile: Profile): ReadonlyMap<string, Provider> => {
  const providers = new Map<string, Provider>()
  const needed = new Set(profile.peers.map((peer) => peer.provider))
  if (needed.has('claude')) providers.set('claude', new ClaudeProvider())
  if (needed.has('deepinfra')) {
    // Same adapter, its own endpoint and limits, all from config (#26). The key
    // is read by the provider from the environment; the daemon never sees it.
    providers.set('deepinfra', createDeepInfraProvider())
  }
  return providers
}

export const compose = async (deps: ComposeDeps): Promise<Composed> => {
  const clock = deps.clock ?? systemClock
  const paths = profilePaths(deps.profileName, deps.roots)
  const profile = await loadProfile(paths.profileFile, paths.profile)
  for (const dir of persistentDirs(paths)) await mkdir(dir, { recursive: true })

  const store = await (deps.openStore ?? openSqliteStore)({ path: paths.storePath, clock })
  await store.migrate()

  const providers = deps.providers ?? buildProviders(profile)
  const pm = deps.pm ?? createProjectManager()
  const wiring: Wiring = { profile, store, providers, clock, pm }

  // The supervisor is the only thing that may hold a provider instance (§2), so
  // it is built first and the Mailbox reaches peers through it (§7).
  const supervisor = createSupervisor({ profile, paths, store, providers, clock })

  const mailbox = createMailbox({
    store: { append: (batch) => store.append(batch), messages: store.reader().messages },
    sessions: supervisor,
    briefs: supervisor.briefs,
    clock,
  })

  // §10: the gate is the only executor that merges, and it needs the GitHub port.
  // Without that port there is no gate at all, so a merge action fails visibly
  // rather than being routed to an executor that cannot do anything.
  const gate =
    deps.pullRequests === undefined
      ? undefined
      : createGate({
          pullRequests: deps.pullRequests,
          store: { append: (batch) => store.append(batch) },
          clock,
          ...(profile.deleteMergedBranches === undefined
            ? {}
            : { deleteMergedBranches: profile.deleteMergedBranches }),
        })

  const executors: KindExecutor[] = [
    ...(gate === undefined ? [] : [{ kinds: gate.kinds, executor: gate }]),
    ...(deps.executors?.({ ...wiring, supervisor }) ?? []),
  ]
  const executor = createExecutorRouter({ executors })

  // §6.1: the profile names the channel, and a profile that names none gets no
  // `notify` routine rather than a silent one — the ledger still records every
  // notification, so turning banners on later re-plays them. Built in its own
  // const (and merged into the installed set) because `notify` is the one body
  // that is not a PM tick: the daemon registers it and nothing else knows it.
  const notifier = deps.notifier ?? notifierFor(profile)
  const factories =
    notifier === undefined
      ? undefined
      : {
          ...installedFactories,
          notify: createNotifyFactory({ store: { append: (batch) => store.append(batch) }, notifier }),
        }

  const scheduler: Scheduler = createScheduler({
    store: { append: (batch) => store.append(batch) },
    read: store.reader(),
    pm,
    executor,
    config: profile.routines,
    clock,
    ...(factories === undefined ? {} : { factories }),
    ...(profile.tickIntervalMs === undefined ? {} : { tickIntervalMs: profile.tickIntervalMs }),
  })

  const daemon = createDaemon({ profile, paths, store, supervisor, mailbox, scheduler, clock })
  const server = await createDaemonServer({
    api: daemon,
    socketPath: paths.socketPath,
    pidPath: paths.pidPath,
    onDown: () => {
      void (async () => {
        await daemon.down()
        await server.close()
        await store.close()
      })()
    },
    onError: (line, response) => {
      // The client already has the answer; this is the log a human reads later.
      console.error(`fleetd: ${line.slice(0, 200)} -> ${response.ok ? 'ok' : response.error.message}`)
    },
  })

  return { daemon, server, store, supervisor, scheduler }
}

/** The log path a supervisor writes to; exported so the log line and §2's layout cannot drift apart. */
export const logPathFor = (profileName: string, roots: PathRoots = {}): string =>
  join(profilePaths(profileName, roots).daemonDir, 'fleetd.log')
