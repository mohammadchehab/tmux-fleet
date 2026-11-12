/**
 * The `security-scan` routine's body (§6.2): run the scanners over a target's
 * checkout, and append what they found.
 *
 * The decisions are all in `@fleet/security-findings` (`planScan` decides what
 * a run produces: raised, seen, skipped), and the tools are all in
 * `@fleet/security-scanners` (each owns its argv and its parse). What is left
 * here is the daemon's own question — *which checkout, and which tools* — and
 * that is exactly the sort of thing §1.1 says only `apps/daemon` may know.
 *
 * Two rules this body adds on top of the planner:
 *
 * 1. **A run with nothing to scan does nothing — and says so when it tried.** A
 *    `pr.opened` names its own head, so it is a target without a guess. The
 *    02:00 schedule names nothing, so the body asks `BranchHead` (a `workspace`
 *    port, §9) for `origin/main` in each profile repo's checkout: that commit is
 *    tonight's target. A repo whose head cannot be read — a checkout with no
 *    `origin/main` — is a recorded skip, never a silent absence (§6.2).
 * 2. **A skip is an action that failed.** §6.2 makes an unrecorded absence a
 *    bug: a PR with no checkout, or a nightly repo whose head would not resolve,
 *    appends one `scan.skipped` naming the tool as `security-scan` and reports
 *    `actionsFailed`, so the routine's own row shows it instead of looking idle.
 *    A nightly repo with *no checkout at all* is the one exception: the fleet has
 *    no copy of it, so there is nothing it meant to scan and nothing to report —
 *    otherwise every repo the fleet is not working in would fail every night.
 *
 * The scan reads an immutable snapshot of the commit — a throwaway detached
 * worktree made from the repository's worktrees (§9), removed afterwards — never
 * a peer's live tree, which keeps changing and sits on some other branch.
 * Scanning the daemon's own cwd would be scanning whatever directory `fleetd`
 * happened to start in, which is a different tree on every host.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppendEvent, BranchHead, EventSink, FleetEvent, ReadModel } from '@fleet/foundation-contracts'
import { shortHash, type Repo, type Sha } from '@fleet/foundation-core'
import type { RoutineContext, RoutineFactory, RoutineOutcome } from '@fleet/orchestration-routines'
import {
  planScan,
  type KnownFinding,
  type ScanOutcome,
  type ScanRequest,
  type ScanResult,
  type Scanner,
} from '@fleet/security-findings'
import { createScanners, type ScannerId, type ToolIo } from '@fleet/security-scanners'

export interface SecurityWiring {
  /** The log, as the routine writes it: `finding.raised`, `finding.seen`, `scan.skipped`. */
  readonly store: EventSink
  /** How a scanner reaches its tool. The daemon passes the real one; a test passes a fake. */
  readonly io: ToolIo
  /** Which tools to run. The profile chose this set, and its presence is what installs the routine. */
  readonly scanners: readonly ScannerId[]
  /** Where gitleaks writes its report; §6.2 tools write into the OS temp directory, never the checkout. */
  readonly reportPath: (name: string) => string
  /**
   * §6.2's 02:00 scan: the repos to scan, the branch whose head names the
   * commit, and the port that reads it. Absent means a scheduled tick scans
   * nothing — a profile with no checkouts configured is not silently pointed at
   * the daemon's cwd.
   */
  readonly nightly?: NightlyScan
  /** Where a snapshot of the scanned commit is made. Absent means the OS temp directory; a test passes a fake. */
  readonly scratch?: Scratch
}

/** What the nightly scan needs: which repos, which branch, and how to name its head. */
export interface NightlyScan {
  readonly repos: readonly Repo[]
  /** The integration branch — `main` — whose head is tonight's scan target. */
  readonly branch: string
  /** The `workspace` port (§9): the only thing that can name a commit nobody in the fleet has observed. */
  readonly head: BranchHead
}

/** One scan this run will perform: a commit and a scope. The checkout it reads is found at the commit, not assumed. */
export interface PlannedTarget {
  readonly request: ScanRequest
}

/**
 * A repository the nightly scan meant to scan but could not name a commit for —
 * a checkout exists, but `origin/<branch>` would not resolve. Kept apart from
 * `targets` because there is no `Sha` to put in a `ScanRequest`; it still
 * becomes a `scan.skipped` so the absence is recorded (§6.2).
 */
export interface UnresolvedRepo {
  readonly repo: Repo
  readonly reason: string
}

/** What a run decided to scan, and what it could not. */
export interface ScanPlan {
  readonly targets: readonly PlannedTarget[]
  readonly unresolved: readonly UnresolvedRepo[]
}

/**
 * §6.2's every-PR rule: a `pr.opened` event names the head SHA, and that is a
 * target we can scan without guessing. Pure over the event, so the rule that a
 * PR is scanned at *its* head is testable on its own.
 */
export const prTargetsOf = (event: FleetEvent | undefined): readonly PlannedTarget[] => {
  if (event === undefined || event.type !== 'pr.opened') return []
  return [
    {
      request: {
        target: { repo: event.data.pr.repo, sha: event.data.headSha, pr: event.data.pr },
        scope: 'diff',
      },
    },
  ]
}

/** A checkout for a repository, from the worktrees the fleet already made (§9). Used to ask the remote, never to scan. */
const checkoutOf = async (read: ReadModel, repo: Repo): Promise<string | undefined> => {
  const worktrees = await read.worktrees.all()
  return worktrees.find((worktree) => worktree.repo === repo)?.path
}

/** One `git` answer in a checkout, or `undefined` when it would not give one. */
const gitIn = async (io: ToolIo, cwd: string, args: readonly string[]): Promise<string | undefined> => {
  try {
    const done = await io.exec('git', args, { cwd })
    return done.code === 0 ? done.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** What making a snapshot of a commit found. */
type SnapshotAt =
  | { readonly kind: 'found'; readonly cwd: string; readonly release: () => Promise<void> }
  | { readonly kind: 'none' }
  | { readonly kind: 'unmatched'; readonly reason: string }

/** A private scratch directory for one snapshot, and the way to remove it. */
export interface Scratch {
  /** Make an empty directory only this user can enter, and return its path. */
  readonly make: () => Promise<string>
  /** Remove a directory `make` returned, and everything in it. Never throws. */
  readonly remove: (path: string) => Promise<void>
}

/** The real scratch space: `mkdtemp` in the OS temp directory, which creates it with mode 0700. */
export const nodeScratch: Scratch = {
  make: () => mkdtemp(join(tmpdir(), 'fleet-scan-')),
  remove: async (path) => {
    try {
      await rm(path, { recursive: true, force: true })
    } catch {
      // Best effort: a leftover scratch directory is private and in the OS temp dir.
    }
  },
}

const fullSha = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

/**
 * An immutable snapshot of exactly `sha`: a throwaway detached worktree under a
 * private temp directory, made from any of the repository's worktrees (they
 * share one object database). Scanning a peer's live worktree instead is racy —
 * the peer keeps editing it while the scan runs, so findings could be filed under
 * a commit the files no longer match — and a peer sits on a `peer/*` branch, so
 * the nightly scan of main's head would almost never find a tree at that commit.
 *
 * Hooks are disabled for the checkout (`core.hooksPath=/dev/null`) because a
 * repository's `post-checkout` would otherwise run during the scan setup. The
 * sha is validated as full hex, so it can never be read as a git option; every
 * command is an argv, never a shell string. The snapshot is removed by `release`,
 * and on any failure here before it is handed back. A repository with no worktree
 * at all is `none`; one whose object database lacks the commit is `unmatched`.
 */
const snapshotAt = async (
  deps: { readonly read: ReadModel; readonly io: ToolIo; readonly scratch: Scratch },
  repo: Repo,
  sha: Sha,
): Promise<SnapshotAt> => {
  const worktrees = (await deps.read.worktrees.all()).filter((worktree) => worktree.repo === repo)
  if (worktrees.length === 0) return { kind: 'none' }
  if (!fullSha.test(sha)) return { kind: 'unmatched', reason: `${sha} is not a full commit hash` }

  let source: string | undefined
  for (const worktree of worktrees) {
    if ((await gitIn(deps.io, worktree.path, ['cat-file', '-e', `${sha}^{commit}`])) !== undefined) {
      source = worktree.path
      break
    }
  }
  if (source === undefined) {
    return { kind: 'unmatched', reason: `commit ${sha} is not present in any checkout of ${repo}`.slice(0, 480) }
  }

  const parent = await deps.scratch.make()
  const path = join(parent, 'snapshot')
  const release = async (): Promise<void> => {
    await gitIn(deps.io, source, ['worktree', 'remove', '--force', path])
    await deps.scratch.remove(parent)
    await gitIn(deps.io, source, ['worktree', 'prune'])
  }
  try {
    const added = await gitIn(deps.io, source, [
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '--detach',
      path,
      sha,
    ])
    const head = added === undefined ? undefined : await gitIn(deps.io, path, ['rev-parse', 'HEAD'])
    if (head?.toLowerCase() !== sha.toLowerCase()) {
      await release()
      return { kind: 'unmatched', reason: `could not snapshot ${sha} of ${repo} from ${source}` }
    }
    return { kind: 'found', cwd: path, release }
  } catch (error) {
    await release()
    throw error
  }
}

/**
 * §6.2's nightly rule: for each profile repo the fleet has a checkout for, the
 * commit `origin/<branch>` points at becomes a full-scope target.
 *
 * A repo with **no checkout** is not a target at all: the fleet has no copy of
 * it, so there is nothing to scan and no failure to report — reporting one every
 * night for every repo the fleet is not currently working in would be the noise
 * that teaches people to ignore `actionsFailed`. A repo that **has** a checkout
 * but whose head cannot be read is different: we meant to scan it and could not,
 * so it is unresolved and recorded (§6.2).
 */
const nightlyScan = async (deps: { readonly read: ReadModel }, nightly: NightlyScan): Promise<ScanPlan> => {
  const targets: PlannedTarget[] = []
  const unresolved: UnresolvedRepo[] = []

  for (const repo of nightly.repos) {
    const cwd = await checkoutOf(deps.read, repo)
    if (cwd === undefined) continue
    const sha = await nightly.head.head(cwd, nightly.branch)
    if (sha === undefined) {
      unresolved.push({ repo, reason: `no ${nightly.branch} head in ${repo} at ${cwd}` })
      continue
    }
    targets.push({ request: { target: { repo, sha }, scope: 'full' } })
  }

  return { targets, unresolved }
}

/**
 * What this run should scan. A `pr.opened` is one target at its own head; a
 * scheduled tick is the nightly scan, and only when a profile wired checkouts to
 * scan; every other trigger has nothing to scan without guessing.
 */
export const scanTargets = async (
  deps: { readonly read: ReadModel; readonly nightly?: NightlyScan },
  context: RoutineContext,
): Promise<ScanPlan> => {
  const byPr = prTargetsOf(context.event)
  if (byPr.length > 0) return { targets: byPr, unresolved: [] }
  if (context.trigger === 'schedule' && deps.nightly !== undefined) return nightlyScan(deps, deps.nightly)
  return { targets: [], unresolved: [] }
}

/** A scanner that throws is a failed scan of its own, not a failed routine: the other tools still report. */
const runScanner = async (scanner: Scanner, request: ScanRequest): Promise<ScanResult> => {
  let outcome: ScanOutcome
  try {
    outcome = await scanner.scan(request)
  } catch (error) {
    outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  return { scanner, outcome }
}

/**
 * The one event a repo we could not scan appends: the absence, stated (§6.2).
 * `sha` is present when the target named a commit and absent when the whole
 * repository could not be resolved — the reason says which.
 */
const skipped = (input: { readonly repo: Repo; readonly sha?: Sha; readonly reason: string }, at: string): AppendEvent => ({
  type: 'scan.skipped',
  ts: at,
  subject: input.repo,
  actor: 'scheduler',
  data: {
    repo: input.repo,
    ...(input.sha === undefined ? {} : { sha: input.sha }),
    // The routine is named as the tool, because it is the thing that declined:
    // no single scanner was reached to be asked.
    tool: 'security-scan',
    reason: input.reason,
  },
})

/**
 * The body. For each target: find its checkout, build the profile's scanners
 * against it, run them, plan, append. The batch is appended once per target, so
 * a store failure is one target's failure and the rest of the run still lands.
 *
 * A repo the nightly scan could not resolve is its own skip and its own failed
 * action, before any target is scanned: the run reports that it meant to scan
 * something and could not, which is what stops an unresolved `main` looking idle.
 */
export const securityScanned = async (
  deps: SecurityWiring & { readonly read: ReadModel },
  context: RoutineContext,
): Promise<RoutineOutcome> => {
  const plan = await scanTargets(deps, context)
  if (plan.targets.length === 0 && plan.unresolved.length === 0) {
    return { actions: 0, actionsFailed: 0, inputsHash: shortHash({ targets: [] }) }
  }

  // The projection is what makes a re-sight a re-sight: a fingerprint already on
  // file is `finding.seen`, and the row keeps the id it was raised under (§6.2).
  const known: readonly KnownFinding[] = (await deps.read.findings.all()).map((finding) => ({
    fingerprint: finding.fingerprint,
    findingId: finding.findingId,
  }))

  let actions = 0
  let actionsFailed = 0
  const hashes: string[] = []
  const at = context.clock.now()

  for (const unresolved of plan.unresolved) {
    await deps.store.append([skipped(unresolved, at)])
    actions += 1
    actionsFailed += 1
    hashes.push(shortHash({ repo: unresolved.repo, reason: unresolved.reason }))
  }

  for (const target of plan.targets) {
    const { repo, sha } = target.request.target
    const found = await snapshotAt({ ...deps, scratch: deps.scratch ?? nodeScratch }, repo, sha)
    if (found.kind !== 'found') {
      const reason = found.kind === 'none' ? `no checkout for ${repo} at ${sha}` : found.reason
      await deps.store.append([skipped({ repo, sha, reason }, at)])
      actions += 1
      actionsFailed += 1
      hashes.push(shortHash({ target: target.request.target, checkout: null }))
      continue
    }
    const cwd = found.cwd

    let results: ScanResult[]
    try {
      const scanners = createScanners(deps.io, { cwd, scanners: deps.scanners, reportPath: deps.reportPath })
      results = await Promise.all(scanners.map((scanner) => runScanner(scanner, target.request)))
    } finally {
      await found.release()
    }
    const scanned = planScan({ ...target.request, results, known, now: at })
    await deps.store.append(scanned.events)

    actions += scanned.raised + scanned.seen + scanned.skipped
    actionsFailed += scanned.failed
    hashes.push(scanned.inputsHash)
  }

  return { actions, actionsFailed, inputsHash: shortHash({ targets: hashes }) }
}

/** The factory the daemon registers in place of §6's default `security-scan` body. */
export const createSecurityScanFactory = (wiring: SecurityWiring): RoutineFactory => (deps) => ({
  kind: 'security-scan',
  run: (context) => securityScanned({ ...wiring, read: deps.read }, context),
})
