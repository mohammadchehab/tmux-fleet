/**
 * The build ledger (architecture §11).
 *
 * > `Build(repo, sha, task)` is unique. A peer requests a build through the API;
 * > the ledger returns the existing result or runs it once. Heavy tasks route to
 * > the remote host (hetzner) by task class in the profile; light ones run
 * > locally. The same SHA+task never runs twice and results are shared by all
 * > peers.
 *
 * Three sentences, three jobs, and they are separable enough to name:
 *
 * 1. **Uniqueness.** `find` before anything else, and an existing row that is
 *    not `running` is the answer — no event, no process. The store's
 *    `UNIQUE (repo, sha, task)` is the second line of that defence; this is the
 *    first, and it is what makes a shared result cheap for the second peer.
 * 2. **One run, even for simultaneous callers.** A peer's request arrives over
 *    the socket while another peer's is already in flight; the store row says
 *    `running` only after an append has landed, and two appends can interleave.
 *    So requests are coalesced in memory by key: the second caller awaits the
 *    first caller's promise rather than the store's row. That map is the only
 *    state this package holds, and it is why the daemon can serve a fleet from
 *    one ledger instance (§2).
 * 3. **Routing.** `routeBuildHost` turns the task's class into a host (§11) and
 *    the runner for that host does the work. A build that ran on the remote host
 *    and one that ran locally are the same two events, which is what lets the
 *    results be read by anything (§11: "results are shared by all peers").
 *
 * A *stale* `running` row — a daemon died mid-build — is reclaimed on the next
 * request for the same key, under the same `buildId`, and the log records the
 * second `build.requested`. Reclaiming is the honest choice: the row promises a
 * result, and no result is coming. It cannot break §11's promise, because
 * nothing was produced to repeat.
 *
 * §17's eval runs are the first consumer: an eval is a build whose task is
 * `evals:<suite>:<provider>:<model>` (`evalBuildTask`), which is exactly
 * "unique on `(repo, sha, suite, provider, model)`" written in §11's key space.
 */

import {
  fleetError,
  newBuildId,
  systemClock,
  type Actor,
  type BuildId,
  type Clock,
  type PeerId,
  type Repo,
  type Sha,
} from '@fleet/foundation-core'
import type {
  AppendEvent,
  Build,
  BuildHost,
  BuildReader,
  EventSink,
} from '@fleet/foundation-contracts'
import { buildKey, buildStdoutPath } from '@fleet/foundation-contracts'

import { routeBuildHost, validateRouting, type BuildRouting } from './host.ts'
import type { BuildCommand, BuildRunResult, BuildRunner } from './runner.ts'
import { buildLogPath, isBuildTimeout } from './runner.ts'

export interface BuildRequest {
  readonly repo: Repo
  readonly sha: Sha
  /** `<class>[:<detail>…]`; see `task.ts`. The class is what routes (§11). */
  readonly task: string
  /** What to run *if* it has to run. Ignored, correctly, when the ledger dedupes. */
  readonly command: BuildCommand
  readonly requestedBy?: PeerId
}

export interface BuildOutcome {
  /** The build as the projection holds it, `succeeded`/`failed`/`cancelled`. */
  readonly build: Build
  /**
   * True when an existing build answered the request and nothing ran. A caller
   * that wants to say "no new work" says it with this, not by timing the call.
   */
  readonly deduped: boolean
}

export interface BuildLedgerDeps {
  /** Where `build.requested` and `build.finished` go (§3). */
  readonly store: EventSink
  /** The projection's builds, for the dedupe (`store.reader().builds`). */
  readonly builds: BuildReader
  readonly routing: BuildRouting
  /** One per host the fleet can reach; `apps/daemon` supplies `local` and, when profiled, `remote`. */
  readonly runners: Readonly<Partial<Record<BuildHost, BuildRunner>>>
  /** `~/.fleet/<profile>/artifacts/builds` (§1.1). */
  readonly logDir: string
  /** Injected so a test pins the timestamp the events carry (§5.4). */
  readonly clock?: Clock
  /** Injected so a test pins the id the events carry (§5.4). */
  readonly mintBuildId?: () => BuildId
}

export interface BuildLedger {
  /** The ledger's whole surface (§11): the existing result, or the one it just ran. */
  request(request: BuildRequest): Promise<BuildOutcome>
  /** Where a task would run, without running it. The profile's routing, read back. */
  hostFor(task: string): BuildHost
}

export const createBuildLedger = (deps: BuildLedgerDeps): BuildLedger => {
  const routing = validateRouting(
    deps.routing,
    (Object.entries(deps.runners) as readonly (readonly [BuildHost, BuildRunner | undefined])[])
      .filter((entry): entry is readonly [BuildHost, BuildRunner] => entry[1] !== undefined)
      .map(([host]) => host),
  )
  const mint = deps.mintBuildId ?? newBuildId
  const clock = deps.clock ?? systemClock
  const inFlight = new Map<string, Promise<BuildOutcome>>()

  const attempt = async (request: BuildRequest): Promise<BuildOutcome> => {
    if (typeof request.task !== 'string' || request.task.length === 0) {
      throw fleetError('invalid_input', 'a build needs a task: it is one half of what the ledger keys a build on')
    }

    // 1. Uniqueness. A build that has an answer answers this request. `cancelled` is not
    // one: the infrastructure failed before the build reached a verdict (see below), and
    // answering a later request with that would make a network blip permanent for the sha.
    const existing = await deps.builds.find(request.repo, request.sha, request.task)
    if (existing !== undefined && existing.status !== 'running' && existing.status !== 'cancelled') {
      return { build: existing, deduped: true }
    }

    // 2. Route, then run once.
    const host = routeBuildHost(request.task, routing)
    const runner = deps.runners[host]
    if (runner === undefined) {
      throw fleetError(
        'invalid_input',
        `${request.task} routes to the ${host} host, but no ${host} runner is configured`,
        { details: { task: request.task, host } },
      )
    }

    const buildId = existing?.buildId ?? mint()
    const logPath = buildLogPath(deps.logDir, request.sha, request.task, request.repo)
    const stdoutPath = buildStdoutPath(logPath)
    // A peer's request is the peer's act; a routine's (a nightly eval on `main`)
    // is the scheduler's. §3 keeps the two distinguishable in the log.
    const actor: Actor =
      request.requestedBy === undefined ? 'scheduler' : (`peer:${request.requestedBy}` as Actor)
    const requested: AppendEvent = {
      type: 'build.requested',
      ts: clock.now(),
      subject: buildId,
      actor,
      data: {
        buildId,
        repo: request.repo,
        sha: request.sha,
        task: request.task,
        host,
        ...(request.requestedBy === undefined ? {} : { requestedBy: request.requestedBy }),
      },
    }
    await deps.store.append([requested])

    const startedAt = Date.now()
    let result: BuildRunResult
    try {
      result = await runner.run({
        buildId,
        repo: request.repo,
        sha: request.sha,
        task: request.task,
        command: request.command,
        logPath,
        stdoutPath,
      })
    } catch (thrown) {
      // A runner that could not start is a build that ended, not a lost one: the log
      // is the runner's to fill in, and the row must not stay `running` (that is a
      // promise no retry would ever keep). The reason travels in the error's own
      // message, which `spawnToLog` also writes into the log.
      //
      // What it ended *as* depends on who failed. A build that overran its limit ran
      // and was too slow: `failed`, and final. Anything else — no such binary, a full
      // disk, a stream that broke — is the infrastructure, which says nothing about the
      // commit, so it is `cancelled` and the next request runs the build again.
      result = {
        status: isBuildTimeout(thrown) ? 'failed' : 'cancelled',
        durationMs: Math.max(1, Date.now() - startedAt),
        exitCode: null,
      }
    }

    const finished: AppendEvent = {
      type: 'build.finished',
      ts: clock.now(),
      subject: buildId,
      actor,
      data: {
        buildId,
        repo: request.repo,
        sha: request.sha,
        task: request.task,
        // §11's `durationMs` is a positive integer; a sub-millisecond fake in a
        // test, or a clock that did not move, is still one millisecond.
        status: result.status,
        logPath,
        durationMs: Math.max(1, Math.round(result.durationMs)),
      },
    }
    await deps.store.append([finished])

    const settled = await deps.builds.get(buildId)
    if (settled === undefined) {
      throw fleetError(
        'internal',
        `the log accepted build ${buildId} but the projection has no row for it; the store's projections are behind its events`,
        { details: { buildId } },
      )
    }
    return { build: settled, deduped: false }
  }

  return {
    hostFor: (task) => routeBuildHost(task, routing),

    async request(request) {
      const id = buildKey(request.repo, request.sha, request.task)
      const pending = inFlight.get(id)
      if (pending !== undefined) return pending

      const promise = attempt(request).finally(() => {
        if (inFlight.get(id) === promise) inFlight.delete(id)
      })
      inFlight.set(id, promise)
      return promise
    },
  }
}
