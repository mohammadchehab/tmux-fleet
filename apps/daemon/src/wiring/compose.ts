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
 * over `gh`, or `integrations/gitlab` over `glab` when the profile names that
 * forge — so every composed daemon has a `merge` executor; it shells out only
 * when a merge or retarget action actually runs, so a fleet that never merges
 * never starts either CLI.
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
  Coordination,
  EventSink,
  ProjectManager,
  ProviderRegistry,
  PullRequests,
  RoutineKind,
  Tracker,
  RepoFiles,
  Worktrees,
  WorktreeProvisioner,
} from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore, type StoreFactory } from '@fleet/foundation-store'
import { createGitHubPullRequests } from '@fleet/integrations-github'
import { createGitLabPullRequests } from '@fleet/integrations-gitlab'
import { createBacklogTracker } from '@fleet/integrations-trackers-backlog'
import { createJiraTracker } from '@fleet/integrations-trackers-jira'
import { readJiraAuth, type JiraCredentialSources } from '../env/jira-env.ts'
import type { Notifier } from '@fleet/notify-core'
import { createGate } from '@fleet/orchestration-gate'
import type { RunProcess } from '@fleet/orchestration-ledger'
import type { JudgeService } from '@fleet/orchestration-judge'
import { createProjectManager } from '@fleet/orchestration-pm'
import { createScheduler, installedFactories, type RoutineFactory, type Scheduler } from '@fleet/orchestration-routines'
import { createMailbox } from '@fleet/runtime-mailbox'
import { ClaudeProvider, createStructuredCompletion } from '@fleet/runtime-provider-claude'
import { createCursorProvider } from '@fleet/runtime-provider-cursor'
import { createDeepInfraProvider } from '@fleet/runtime-provider-deepinfra'
import type { Provider } from '@fleet/runtime-provider-sdk'
import type { BookkeepingFailure } from '@fleet/runtime-supervisor'
import { execFileExec, readFileNode, tempPathNode, whichProbe, type ToolIo } from '@fleet/security-scanners'
import { createBranchHead, createRepoFiles, createWorktreeProvisioner, createWorktrees } from '@fleet/workspace-worktree'
import { createBranchCleanupFactory } from '../routines/branch-cleanup.ts'
import { coordinationFor } from '../routines/coordination.ts'
import { createDaemon, type Daemon } from './daemon.ts'
import { createDaemonBuilds } from './builds.ts'
import { createProviderEnv, judgeEnvFor, type DeepInfraEnvOptions } from '../env/deepinfra-env.ts'
import { createExecutorRouter, type KindExecutor } from '../execution/executor.ts'
import { createDaemonExecutors } from '../execution/executors.ts'
import { createDaemonJudge } from '../execution/judge.ts'
import { acquireFleetLock, type FleetLock } from './lock.ts'
import { createNotifyFactory, notifierFor } from '../routines/notify.ts'
import { createPrBabysitFactory } from '../routines/pr-babysit.ts'
import { loadProfile, type Profile, type TrackerProfile } from '../config/profile.ts'
import { createSecurityScanFactory } from '../routines/security.ts'
import { createDaemonServer, type DaemonServer } from '../api/server.ts'
import { createSupervisor, type Supervisor } from '../execution/sessions.ts'
import { createStandingBriefs } from '../execution/standards.ts'
import { createTrackerSyncFactory } from '../routines/tracker-sync.ts'
import { createWorktreeGcFactory } from '../routines/worktree-gc.ts'
import { createDisplayFeed, rowOf } from '../execution/display.ts'
import { createWakingSink, deliverOnSessionStart } from '../execution/wake.ts'
import { syncWork } from '../execution/work-sync.ts'

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
  /**
   * shared-fleet.md §2: the coordination transport, for a profile with a `coord`
   * block. Defaults to git against the block's repository; a test passes the
   * in-memory one, so a suite never reaches GitHub.
   */
  readonly coordination?: Coordination
  /** Who this fleet publishes as, when `coord.user` is absent. Defaults to asking `gh`. */
  readonly githubLogin?: () => Promise<string>
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
  /**
   * How §9's manager removes a checkout of a Work that has merged (§10's
   * `branch-cleanup`). Defaults to a `git` adapter; a test passes a fake, so a
   * suite never removes a directory on the machine it runs on.
   */
  readonly worktrees?: Worktrees
  /** §9's creator; absent, the real `git`. A test supplies one so no repository is touched. */
  readonly worktreeProvisioner?: WorktreeProvisioner
  /** §12.1: where a peer's repo standards are read from; absent, the default branch via the real `git`. */
  readonly repoFiles?: RepoFiles
  /**
   * The board `tracker-sync` reads and writes (§3). Defaults to the adapter the
   * profile's `trackers.system` names — `@fleet/integrations-trackers-backlog`
   * over its CLI; a test passes a fake, so a suite never initialises a project
   * or touches a board.
   */
  readonly tracker?: Tracker
  /**
   * How the process ends once `down` has been answered. Defaults to exiting:
   * a daemon that has said "stopped" and then stayed alive is a daemon the next
   * `up` cannot start on the same store. A test passes its own, because exiting
   * would take the test runner with it.
   */
  readonly exit?: () => void
  /**
   * How a build reaches a process (§11). Defaults to `spawn`, which is what a
   * composed fleet uses; a test passes a fake, so a suite never runs a build or
   * an `ssh`.
   */
  readonly buildProcess?: RunProcess
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
   * §5.3's Judge, exposed for the same reason as `scheduler`: a test composing a
   * real fleet has no other handle on it, and the two things worth asserting
   * about it — which model answers, and where the call is sent — are properties
   * of this object rather than of anything the ledger records.
   */
  readonly judge: JudgeService
  /**
   * The waking sink's own append. A composed fleet's writes have to wake the same
   * way the daemon's do — a test that appended straight to the store would be
   * testing a log nothing is listening to (§5.2).
   */
  readonly append: EventSink['append']
  /**
   * The store's pid lock. Exposed so every way a composed fleet stops — a
   * signal, a `down` over the socket, a test's own teardown — gives the store
   * back the same way, instead of each one inventing a release.
   */
  readonly lock: FleetLock
}

/**
 * §10's port for the profile's forge. Both adapters answer the same interface,
 * so the gate and the retarget sweep never learn which one they hold; only this
 * function does. GitHub is the default because a profile without a `forge` block
 * is a fleet that predates the choice.
 *
 * A GitLab host is passed to the adapter rather than to the process: `glab`
 * resolves a host from the working directory's git remote or its own config, and
 * neither describes where the daemon runs, so a self-hosted forge would otherwise
 * be reached only when someone happened to be standing in the right checkout.
 */
export const createPullRequests = (profile: Profile): PullRequests => {
  const forge = profile.forge
  if (forge?.kind !== 'gitlab') return createGitHubPullRequests()
  return createGitLabPullRequests(forge.host === undefined ? {} : { host: forge.host })
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
  if (needed.has('cursor')) {
    // Read-only, plan-mode only: the adapter refuses any other permission mode,
    // so a profile that listed a cursor peer cannot make it a writing one. The
    // block carries context windows and, on a machine that is not logged in, the
    // *reference* to a key (`tokenEnv`/`tokenFile`, TASK-24). The key itself is
    // resolved per session by `providerEnv` and never reaches this provider's config.
    const block = profile.providers?.cursor
    providers.set(
      'cursor',
      createCursorProvider({
        ...(block?.contextLimits === undefined ? {} : { contextLimits: block.contextLimits }),
      }),
    )
  }
  return providers
}

/**
 * §3: the adapter the profile's `trackers.system` names. `deps.tracker` still
 * wins over both — a caller with its own board, or a test, supplies one and
 * nothing here is constructed. Building either adapter is offline: Backlog.md
 * runs only when it is polled, and Jira's client resolves no URL until a call.
 *
 * A Jira site's token is read here, through `jira-env.ts`, and never from the
 * profile: the profile says where it lives. That is why this is `async` — the
 * file source is read with the filesystem — and why a site with no reachable
 * credential fails compose rather than every later sync.
 */
const trackerFor = async (profile: TrackerProfile, credentials: JiraCredentialSources): Promise<Tracker> => {
  if (profile.system === 'backlog') {
    return createBacklogTracker({
      path: profile.path,
      ...(profile.statuses === undefined ? {} : { statuses: profile.statuses }),
      ...(profile.urlBase === undefined ? {} : { urlBase: profile.urlBase }),
    })
  }
  return createJiraTracker({
    baseUrl: profile.baseUrl,
    auth: await readJiraAuth({ ...credentials, auth: profile.auth }),
    ...(profile.statuses === undefined ? {} : { statuses: profile.statuses }),
    ...(profile.search === undefined ? {} : { search: profile.search }),
  })
}

/**
 * The daemon log's one line for a bookkeeping append the store refused
 * (TASK-57, TASK-82): the peer, the row, the turn when it had one, and what the
 * store said. Named rather than inlined into the wiring below so the sentence a
 * person reads is the thing under test, and so it is one line per failure by
 * construction.
 */
export const bookkeepingFailureLine = (failure: BookkeepingFailure): string => {
  const reason = failure.error instanceof Error ? failure.error.message : String(failure.error)
  const turn = failure.turnId === undefined ? '' : ` on turn ${String(failure.turnId)}`
  return `fleetd: bookkeeping for ${String(failure.peerId)} failed writing ${failure.record}${turn} and the session stays live: ${reason}`
}

export const compose = async (deps: ComposeDeps): Promise<Composed> => {
  const clock = deps.clock ?? systemClock
  const paths = profilePaths(deps.profileName, deps.roots)
  const profile = await loadProfile(paths.profileFile, paths.profile)
  for (const dir of persistentDirs(paths)) await mkdir(dir, { recursive: true })

  // Before the store, not after: two fleetds that both open it have already
  // interleaved on it, and the point of the lock is that the second one never
  // gets that far. A compose that throws from here on leaves the file behind
  // with this process's pid in it, which is the state the lock's next starter
  // already knows how to read — the pid is dead as soon as this process is.
  // A live pid in the lock is not proof of a live fleetd — after a reboot the
  // number can belong to anything — so the socket is handed over: a daemon that
  // answers there and names that pid is the evidence, and a pid that is neither
  // serving nor looks like `fleetd` is taken over (§2).
  const lock = await acquireFleetLock(paths.lockPath, { socketPath: paths.socketPath })
  const stop = deps.exit ?? (() => process.exit(0))

  const store = await (deps.openStore ?? openSqliteStore)({ path: paths.storePath, clock })
  await store.migrate()

  const providers = deps.providers ?? buildProviders(profile)
  // §6.1's spend cap is a PM rule, so the profile's budget is policy the PM holds rather than something a rule
  // reaches for: no `budget` block means no cap, and the rule then never asks about money.
  const pm =
    deps.pm ??
    createProjectManager(profile.budget === undefined ? {} : { budgetUsd: profile.budget.usd })

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
  const providerEnvOptions: DeepInfraEnvOptions = {
    profile,
    environ: deps.environ ?? process.env,
    configHome: paths.configHome,
  }
  const providerEnv = createProviderEnv(providerEnvOptions)

  // §5.3's Judge is a provider path, so it gets the same fragment a peer's
  // session does — from the profile's `judge:` block, never from fleetd's own
  // identity. Read once here rather than per question, because the Judge is one
  // call site and a question is not a session.
  //
  // No block means no fragment, which is the old behaviour deliberately kept: a
  // machine that is logged in answers on that login, and a profile that wants the
  // Judge somewhere else says so. What must not happen is the silent version — a
  // `judge:` block that names a provider and is then ignored — so a missing key
  // throws here, before the fleet is up, rather than being discovered later as a
  // question that escalated for no stated reason.
  const judgeEnv = await judgeEnvFor(providerEnvOptions)(profile.judge)

  // The supervisor is the only thing that may hold a provider instance (§2), so
  // it is built first and the Mailbox reaches peers through it (§7). It appends
  // through the waking sink, because `session.started` is the event that wakes
  // the delivery of whatever is waiting for that peer.
  // What `fleet watch` reads (watch-and-attach §6): in memory, never stored.
  const display = createDisplayFeed({ now: () => clock.now() })
  const supervisor = createSupervisor({
    profile,
    display,
    paths,
    read: store.reader(),
    worktrees: deps.worktreeProvisioner ?? createWorktreeProvisioner(),
    standing: createStandingBriefs({
      profile,
      paths,
      repoFiles: deps.repoFiles ?? createRepoFiles(),
      events: store,
      read: store.reader(),
      append: wake.append,
      clock,
    }),
    store: wake, providers, clock, providerEnv,
    // TASK-117: a session failure the supervisor could not act on itself used to
    // be dropped on the floor, so the daemon log said nothing. It is the same log
    // every other fleetd line goes to (`logPathFor`).
    onError: (peerId, error) => {
      console.error(`fleetd: peer ${String(peerId)}: ${error instanceof Error ? error.message : String(error)}`)
    },
    // TASK-57: a bookkeeping row the store refused is not a dead session, but it
    // must not vanish either — the spend cap reads these rows, and a fleet that
    // silently stopped measuring would look exactly like a fleet that stopped
    // spending. One line per failure, with the peer, the turn and what the store said.
    onBookkeepingFailure: (failure) => {
      console.error(bookkeepingFailureLine(failure))
    },
  })

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

  // §6: the rows a watch needs from the store — state changes, mail, decisions — go
  // out on the same stream as the lines, so the view does not poll.
  wake.listen(async (event) => {
    const row = rowOf(event)
    if (row !== undefined) display.row(row)
  })

  // §5.1: the Work state machine advances on the events the fleet already writes.
  // Registered after delivery so the brief reaches the peer before the Work is said
  // to have started — a listener added later cannot see an event before an earlier one.
  wake.listen(syncWork({ read: store.reader(), append: wake.append, clock }))

  // §10: the gate is the only executor that merges, and it needs the forge's port.
  // Building one runs nothing: `gh`/`glab` start only when a merge or retarget
  // action gets that far, so a fleet that never merges never shells out.
  const pullRequests: PullRequests = deps.pullRequests ?? createPullRequests(profile)
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
      // directory with no session, no tools and no settings. `env` is the
      // profile's `judge:` fragment (see above), so the answering model is the
      // one the profile named rather than whatever identity fleetd was started
      // with; absent a block, the cheap default model on fleetd's own identity.
      transport: createStructuredCompletion({ cwd: paths.stateDir, env: judgeEnv }),
      ...(profile.judge === undefined ? {} : { model: profile.judge.model }),
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

  const executor = createExecutorRouter({
    executors,
    onFailed: (outcome) =>
      console.error(`fleetd: ${outcome.action.kind} failed: ${outcome.error ?? 'no reason given'}`),
  })

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
  const trackers = profile.trackers
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
    // §9's `worktree-gc` is always on too: `branch-cleanup` removes the checkout
    // that goes *with* a branch it deleted, and nothing else ever took a checkout
    // back — a PR closed rather than merged, or a merge that landed while the
    // daemon was down, leaves one on disk for good. It needs the forge (only the
    // forge can say a PR closed), a sink, the Mailbox and §9's manager, so it is
    // registered here like the two above.
    'worktree-gc': createWorktreeGcFactory({
      pullRequests,
      store: { append: (batch) => store.append(batch) },
      mailbox,
      worktrees: deps.worktrees ?? createWorktrees(),
    }),
    // §10's `branch-cleanup` is always on, like `pr-babysit`: without it nothing
    // ever deletes a branch (§10's `--delete-branch` was taken off the merge in
    // #102), and a fleet leaves one branch per PR behind. It needs the port, a
    // sink, the Mailbox and §9's manager, so it is registered here.
    'branch-cleanup': createBranchCleanupFactory({
      pullRequests,
      store: { append: (batch) => store.append(batch) },
      mailbox,
      worktrees: deps.worktrees ?? createWorktrees(),
      repos: profile.repos.map((name) => parse(repo(), name)),
    }),
    ...(notifier === undefined
      ? {}
      : { notify: createNotifyFactory({ store: { append: (batch) => store.append(batch) }, notifier }) }),
    // §3: a profile with no `trackers` block gets no `tracker-sync` routine rather
    // than one that polls nothing. Unlike `notify` and `security-scan` this body
    // gets the *waking* sink: `work.proposed` is what dispatch needs to hear, and
    // neither type it appends is one its own trigger names (§6).
    ...(trackers === undefined
      ? {}
      : {
          'tracker-sync': createTrackerSyncFactory({
            tracker:
              deps.tracker ??
              (await trackerFor(trackers, {
                environ: deps.environ ?? process.env,
                configHome: paths.configHome,
              })),
            store: { append: wake.append },
            system: trackers.system,
            query: trackers.query,
            ...(trackers.role === undefined ? {} : { role: trackers.role }),
            ...(trackers.comments === undefined ? {} : { comments: trackers.comments }),
          }),
        }),
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

  // §11's ledger, wired here and nowhere else: the profile names the remote
  // host, this file builds the `ssh` runner for it, and the ledger appends
  // through `wake` so a finished build wakes the routines like any other event.
  const ledger = createDaemonBuilds({
    profile,
    sink: { append: wake.append },
    builds: store.reader().builds,
    logDir: join(paths.artifactsDir, 'builds'),
    clock,
    ...(deps.buildProcess === undefined ? {} : { process: deps.buildProcess }),
  })

  // shared-fleet.md §3: a profile in a shared project publishes its pace. `loadProfile`
  // has refused a `coord` block without a `budget`, so the cap is there. Built
  // before the daemon and started by `up`, so `fleet up` is where a missing `gh`
  // login is refused rather than a log line an hour later.
  const coordination =
    profile.coord === undefined || profile.budget === undefined
      ? undefined
      : await coordinationFor({
          coord: profile.coord,
          capUsd: profile.budget.usd,
          paths,
          read: store.reader(),
          clock,
          ...(deps.coordination === undefined ? {} : { coordination: deps.coordination }),
          ...(deps.githubLogin === undefined ? {} : { login: deps.githubLogin }),
        })

  const daemon = createDaemon({
    profile,
    paths,
    store,
    append: wake.append,
    supervisor,
    mailbox,
    scheduler,
    ledger,
    clock,
    // So `fleet up` can say when a profile asked for an effort the provider it
    // named cannot honour (TASK-12): the map here is the one the sessions run on.
    providerCapabilities: (name) => providers.get(name)?.capabilities,
    ...(coordination === undefined ? {} : { coordination }),
  })
  const server = await createDaemonServer({
    api: daemon,
    socketPath: paths.socketPath,
    pidPath: paths.pidPath,
    watch: (params) => display.watch(params),
    onDown: () => {
      void (async () => {
        try {
          display.closeAll('shutdown')
          await daemon.down()
          await server.close()
          await store.close()
          await lock.release()
          // The last step, and the reason `down` means what it says: every port
          // is closed, so nothing is left to drain and the process can end here
          // rather than wait for a signal that will never come.
          stop()
        } catch (error) {
          // If cleanup fails after down has answered ok, log it and still release
          // resources so the next fleet can start on the same store (§2).
          console.error(`fleetd: failed to shut down cleanly: ${String(error)}`)
          try {
            await store.close()
            await lock.release()
          } catch {
            // Suppress secondary errors during cleanup; the primary one is logged.
          }
          stop()
        }
      })()
    },
    onError: (line, response) => {
      // The client already has the answer; this is the log a human reads later.
      console.error(`fleetd: ${line.slice(0, 200)} -> ${response.ok ? 'ok' : response.error.message}`)
    },
  })

  return { daemon, server, store, supervisor, scheduler, judge, append: wake.append, lock }
}

/** The log path a supervisor writes to; exported so the log line and §2's layout cannot drift apart. */
export const logPathFor = (profileName: string, roots: PathRoots = {}): string =>
  join(profilePaths(profileName, roots).daemonDir, 'fleetd.log')
