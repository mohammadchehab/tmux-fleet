/**
 * `fleetd`'s entry point (§2): the composition root, and the only file that
 * knows a concrete provider, a concrete store or a concrete supervisor.
 * (`deepinfra-env.ts` names `deepInfraEnv` too, but only to build one session's
 * env from it; nothing there constructs a provider or knows its endpoint.)
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
 * 4. **Mailbox, Judge, executor, scheduler, server.** Each takes only the ports
 *    it needs (§1.1).
 *
 * One thing a profile may ask for but this build cannot yet deliver is named as
 * such rather than silently replaced: `orchestration/briefs` (the `assign` and
 * `supersede_brief` executors). The gate's port is real — `integrations/github`
 * over `gh` — so every composed daemon has a `merge` executor; it shells out
 * only when a merge or retarget action actually runs, so a fleet that never
 * merges never starts a `gh`.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parse,
  persistentDirs,
  profilePaths,
  repo,
  systemClock,
  type Clock,
  type PathRoots,
  type Repo,
} from '@fleet/foundation-core'
import type {
  BranchHead,
  EventSink,
  ProjectManager,
  ProviderRegistry,
  PullRequests,
  RoutineKind,
} from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore, type StoreFactory } from '@fleet/foundation-store'
import { createGitHubPullRequests } from '@fleet/integrations-github'
import type { Notifier } from '@fleet/notify-core'
import { createGate } from '@fleet/orchestration-gate'
import type { JudgeService } from '@fleet/orchestration-judge'
import { createProjectManager } from '@fleet/orchestration-pm'
import { createScheduler, installedFactories, type RoutineFactory, type Scheduler } from '@fleet/orchestration-routines'
import { createMailbox } from '@fleet/runtime-mailbox'
import { ClaudeProvider, createStructuredCompletion } from '@fleet/runtime-provider-claude'
import { createDeepInfraProvider } from '@fleet/runtime-provider-deepinfra'
import type { Provider } from '@fleet/runtime-provider-sdk'
import { execFileExec, readFileNode, tempPathNode, whichProbe, type ToolIo } from '@fleet/security-scanners'
import { createBranchHead } from '@fleet/workspace-worktree'
import { createDaemon, type Daemon } from './daemon.ts'
import { createProviderEnv } from './deepinfra-env.ts'
import { createExecutorRouter, type KindExecutor } from './executor.ts'
import { createDaemonExecutors } from './executors.ts'
import { createDaemonJudge } from './judge.ts'
import { createNotifyFactory, notifierFor } from './notify.ts'
import { createPrBabysitFactory } from './pr-babysit.ts'
import { loadProfile, type Profile } from './profile.ts'
import { createSecurityScanFactory } from './security.ts'
import { createDaemonServer, type DaemonServer } from './server.ts'
import { createSupervisor, type Supervisor } from './sessions.ts'
import { createWakingSink, deliverOnSessionStart } from './wake.ts'
import { syncWork } from './work-sync.ts'

export interface Wiring {
  readonly profile: Profile
  readonly store: EventStore
  /**
   * The store's append, waking as it goes (§5.2). An executor built from this
   * wiring writes through `append`, not `store.append`: the second one is the
   * log, the first is the log plus the routines it wakes.
   */
  readonly append: EventSink['append']
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
  /**
   * fleetd's own environment, which is where a profile's `tokenEnv` names a
   * variable. Defaults to `process.env`; a test passes a map, so it never has to
   * set a real credential in the process it runs in.
   */
  readonly environ?: Readonly<Record<string, string | undefined>>
  /** The PM that decides (§5.2). Defaults to `@fleet/orchestration-pm`'s own. */
  readonly pm?: ProjectManager
  /**
   * The gate's §10 port. Defaults to `@fleet/integrations-github` over `gh`; a
   * test passes a fake, so a suite never authenticates or touches a repository.
   */
  readonly pullRequests?: PullRequests
  /** Providers to construct instead of the built-in set, by the profile's `provider` name. */
  readonly providers?: ReadonlyMap<string, Provider>
  /**
   * The Judge (§5.3). Defaults to one over a one-shot Claude structured call, in
   * the profile's state directory. A test passes a scripted one; a profile that
   * wants DeepInfra's endpoint supplies its own, because only the caller knows
   * that credential.
   */
  readonly judge?: (wiring: Wiring & { readonly supervisor: Supervisor }) => JudgeService
  /**
   * Extra executors for kinds this file does not own — the notifier (§6.1), and
   * `assign`/`supersede_brief` once `orchestration/briefs` lands. A kind claimed
   * twice is refused by the router rather than carried out twice (§5.2).
   */
  readonly executors?: (wiring: Wiring & { readonly supervisor: Supervisor }) => readonly KindExecutor[]
  /**
   * The channel notifications ring on (§6.1). Defaults to the profile's
   * `notify.channel`: `macos` builds the desktop channel, `none` — or no
   * `notify` block at all — installs no `notify` routine. A test passes its own
   * so a run cannot put a banner on someone's screen.
   */
  readonly notifier?: Notifier
  /**
   * How the §6.2 scanners reach their tools. Defaults to running the real
   * binaries; a test passes a fake, so a suite never needs semgrep installed and
   * a scan never shells out from a test run.
   */
  readonly securityIo?: ToolIo
  /**
   * How the nightly §6.2 scan names `main`'s head (§9). Defaults to a `git`
   * adapter; a test passes a fake, so a suite never fetches a remote.
   */
  readonly branchHead?: BranchHead
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
  /**
   * The waking sink's own append. A composed fleet's writes have to wake the same
   * way the daemon's do — a test that appended straight to the store would be
   * testing a log nothing is listening to (§5.2).
   */
  readonly append: EventSink['append']
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
    // Same adapter, its own endpoint and limits, all from config (#26). The
    // credential is not part of this config: it belongs to a session, and
    // `deepinfra-env.ts` is the one place that reads it.
    //
    // The profile's `providers.deepinfra` block is handed over unchanged rather
    // than re-checked here: the adapter is what refuses an id it cannot serve,
    // and it refuses it on every path — a start, a resume and a `setModel` — so
    // a policy enforced here would be one the late paths could step around.
    const block = profile.providers?.deepinfra
    providers.set(
      'deepinfra',
      createDeepInfraProvider({
        ...(block?.baseUrl === undefined ? {} : { baseUrl: block.baseUrl }),
        ...(block?.allowedModels === undefined ? {} : { allowedModels: block.allowedModels }),
      }),
    )
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

  // §5.2: an append is the fleet's clock, so every committed batch wakes what
  // listens for it. The sink wraps the store rather than living inside it: the
  // store is a log and knows nothing about routines.
  let scheduler: Scheduler | undefined
  const wake = createWakingSink({
    append: (batch) => store.append(batch),
    read: (from, limit) => store.read(from, limit),
    scheduler: () => scheduler,
    onError: (error, event) => {
      // After the commit, so this is a report and not a reply to anyone: the
      // caller's write stands, and a routine that did not run is in the log here.
      console.error(`fleetd: wake failed on ${event.type} #${String(event.seq)}: ${String(error)}`)
    },
  })

  const wiring: Wiring = { profile, store, append: wake.append, providers, clock, pm }

  // §4: a DeepInfra peer's key is read per session — from fleetd's own
  // environment or the file the profile names — never stored, never in argv,
  // never in an event or an error. The supervisor asks again on every start, so
  // a rotated key takes effect without restarting the daemon.
  const providerEnv = createProviderEnv({
    profile,
    environ: deps.environ ?? process.env,
    configHome: paths.configHome,
  })

  // The supervisor is the only thing that may hold a provider instance (§2), so
  // it is built first and the Mailbox reaches peers through it (§7). It appends
  // through the waking sink, because `session.started` is the event that wakes
  // the delivery of whatever is waiting for that peer.
  const supervisor = createSupervisor({ profile, paths, store: wake, providers, clock, providerEnv })

  const mailbox = createMailbox({
    store: { append: wake.append, messages: store.reader().messages },
    sessions: supervisor,
    briefs: supervisor.briefs,
    clock,
  })

  // §7: a peer that reaches running gets what is waiting for it. A message sent to a
  // peer that was not up is `pending` in the box, and `session.started` — including
  // the one a resume produces — is what retries it. See `deliverOnSessionStart` for
  // why a delivery already in flight for that peer is left alone.
  wake.listen(deliverOnSessionStart(mailbox))

  // §5.1: the Work state machine advances on the events the fleet already writes.
  // Registered after delivery so the brief reaches the peer before the Work is said
  // to have started — a listener added later cannot see an event before an earlier one.
  wake.listen(syncWork({ read: store.reader(), append: wake.append, clock }))

  // §10: the gate is the only executor that merges, and it needs the GitHub port.
  // Building the port runs nothing: `gh` starts only when a merge or retarget
  // action gets that far, so a fleet that never merges never shells out.
  const pullRequests: PullRequests = deps.pullRequests ?? createGitHubPullRequests()
  const gate = createGate({
    pullRequests,
    store: { append: wake.append },
    clock,
    ...(profile.deleteMergedBranches === undefined ? {} : { deleteMergedBranches: profile.deleteMergedBranches }),
  })

  const executors: KindExecutor[] = [
    { kinds: gate.kinds, executor: gate },
    ...(deps.executors?.({ ...wiring, supervisor }) ?? []),
  ]

  // §5.2's actions are performed by whoever holds the dependency they need, and
  // `apps/daemon` holds the Mailbox, the Judge and the projections — so those
  // five executors are always wired, not opt-in. An action with no home fails
  // visibly instead (§5.2).
  const judge =
    deps.judge?.({ ...wiring, supervisor }) ??
    createDaemonJudge({
      store,
      // §5.3's transport: one schema-constrained call, run in the profile's own
      // directory with no session, no tools and no settings. The Judge's own
      // default model is the cheap one (§5.3) until a profile names another.
      transport: createStructuredCompletion({ cwd: paths.stateDir }),
      clock,
    })
  executors.push(
    ...createDaemonExecutors({
      // An action is an append like any other, so it wakes like any other (§5.2).
      // A routine acting from its own wake is safe: the scheduler skips a run of a
      // routine that is already in flight (§6).
      store: { append: wake.append },
      read: store.reader(),
      mailbox,
      judge,
      clock,
    }),
  )

  const executor = createExecutorRouter({ executors })

  // §6.1 and §6.2 are the two bodies the daemon registers itself: neither is a PM
  // tick, and neither may grow `RoutineBodyDeps` (§6) — each is a factory closing
  // over the ports only this file may name.
  //
  // Both are opt-in, and their absence is silent by design. A profile with no
  // `notify` block gets no `notify` routine rather than a quiet one — the ledger
  // still records every notification, so turning banners on later re-plays them.
  // A profile with no `security` block gets no `security-scan` routine at all:
  // scanning is three subprocesses per PR, and a fleet that did not ask for it
  // must not look like it is doing it.
  const notifier = deps.notifier ?? notifierFor(profile)
  const scanners = profile.security?.scanners
  const overrides: Partial<Record<RoutineKind, RoutineFactory>> = {
    // §6's `pr-babysit` is always on — it is the fleet's only poller of its own PRs,
    // and without it a row never leaves `checks: pending`. It needs the forge's port,
    // a sink and the Mailbox, so it is registered here like `notify`. The repos are
    // decoded now rather than on the first poll: a misspelt repo is a profile
    // mistake, and `fleet up` should be where it is refused.
    'pr-babysit': createPrBabysitFactory({
      pullRequests,
      // The raw store, like `notify`: these facts are the outcome of a wake, and
      // routing them through the waking sink would run this routine inside itself.
      store: { append: (batch) => store.append(batch) },
      mailbox,
      repos: profile.repos.map((name) => parse(repo(), name)),
    }),
    ...(notifier === undefined
      ? {}
      : { notify: createNotifyFactory({ store: { append: (batch) => store.append(batch) }, notifier }) }),
    ...(scanners === undefined
      ? {}
      : {
          'security-scan': createSecurityScanFactory({
            // The raw store, like `notify`: a `finding.raised` wakes nothing, and
            // routing it through the sink would invite a routine run per finding.
            store: { append: (batch) => store.append(batch) },
            io: deps.securityIo ?? { exec: execFileExec, has: whichProbe(execFileExec), readFile: readFileNode },
            scanners,
            reportPath: tempPathNode,
            // §6.2's 02:00 scan: main's head, read from each repo's checkout through
            // the `workspace` port (§9). A profile with no repos scans nothing.
            nightly: {
              repos: profile.repos.map((name) => name as Repo),
              branch: 'main',
              head: deps.branchHead ?? createBranchHead(),
            },
          }),
        }),
  }
  const factories: Readonly<Partial<Record<RoutineKind, RoutineFactory>>> = { ...installedFactories, ...overrides }

  // The scheduler appends through the *raw* store on purpose: its own routine
  // events (`routine.started`, `routine.finished`) are the outcome of a wake, and
  // waking on them would run a routine inside a routine. Everything outside it —
  // the supervisor, the Mailbox, the executors, `up` — appends through `wake`.
  scheduler = createScheduler({
    store: { append: (batch) => store.append(batch) },
    read: store.reader(),
    pm,
    executor,
    config: profile.routines,
    clock,
    factories,
    ...(profile.tickIntervalMs === undefined ? {} : { tickIntervalMs: profile.tickIntervalMs }),
  })

  const daemon = createDaemon({ profile, paths, store, append: wake.append, supervisor, mailbox, scheduler, clock })
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

  return { daemon, server, store, supervisor, scheduler, append: wake.append }
}

/** The log path a supervisor writes to; exported so the log line and §2's layout cannot drift apart. */
export const logPathFor = (profileName: string, roots: PathRoots = {}): string =>
  join(profilePaths(profileName, roots).daemonDir, 'fleetd.log')
