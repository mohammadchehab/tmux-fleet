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
 * 1. **A run with nothing to scan does nothing.** A scheduled tick has no
 *    target: the fleet has no head-sha source for main yet (there is no
 *    workspace/git package to ask), so the nightly path is not wired. Rather
 *    than scan a guess, the body returns zero actions — and this paragraph is
 *    the record that the path is missing, not the inference that it works.
 * 2. **No checkout is a skip, and a skip is an action that failed.** §6.2 makes
 *    an unrecorded absence a bug: a PR we could not scan appends one
 *    `scan.skipped` naming the tool as `security-scan` and reports
 *    `actionsFailed`, so the routine's own row shows it instead of looking idle.
 *
 * The checkout is the worktree the fleet already made for that repository (§9).
 * Scanning the daemon's own cwd would be scanning whatever directory `fleetd`
 * happened to start in, which is a different tree on every host.
 */

import type { AppendEvent, EventSink, FleetEvent, ReadModel } from '@fleet/foundation-contracts'
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
}

/** One scan this run will perform: a commit, a scope, and the checkout it reads. */
export interface PlannedTarget {
  readonly request: ScanRequest
  /** The worktree the tools are pointed at (§9), or `undefined` when the fleet has none for this repo. */
  readonly cwd?: string
}

/**
 * What this run should scan. §6.2's every-PR rule and nothing else: a `pr.opened`
 * event names the head SHA, and that is a target we can scan without guessing.
 * Every other trigger — the 02:00 schedule, a start-up tick, a manual wake —
 * has no target until the fleet can name main's head.
 */
export const targetsOf = (event: FleetEvent | undefined): readonly PlannedTarget[] => {
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

/** A checkout for a repository, from the worktrees the fleet already made (§9). */
const checkoutOf = async (read: ReadModel, repo: Repo): Promise<string | undefined> => {
  const worktrees = await read.worktrees.all()
  return worktrees.find((worktree) => worktree.repo === repo)?.path
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

/** The one event a run with no checkout appends: the absence, stated (§6.2). */
const noCheckout = (target: { readonly repo: Repo; readonly sha: Sha }, at: string): AppendEvent => ({
  type: 'scan.skipped',
  ts: at,
  subject: target.repo,
  actor: 'scheduler',
  data: {
    repo: target.repo,
    sha: target.sha,
    // The routine is named as the tool, because it is the thing that declined:
    // no single scanner was reached to be asked.
    tool: 'security-scan',
    reason: `no checkout for ${target.repo} at ${target.sha}`,
  },
})

/**
 * The body. For each target: find its checkout, build the profile's scanners
 * against it, run them, plan, append. The batch is appended once per target, so
 * a store failure is one target's failure and the rest of the run still lands.
 */
export const securityScanned = async (
  deps: SecurityWiring & { readonly read: ReadModel },
  context: RoutineContext,
): Promise<RoutineOutcome> => {
  const planned = targetsOf(context.event)
  if (planned.length === 0) return { actions: 0, actionsFailed: 0, inputsHash: shortHash({ targets: [] }) }

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

  for (const target of planned) {
    const cwd = await checkoutOf(deps.read, target.request.target.repo)
    if (cwd === undefined) {
      await deps.store.append([noCheckout(target.request.target, at)])
      actions += 1
      actionsFailed += 1
      hashes.push(shortHash({ target: target.request.target, checkout: null }))
      continue
    }

    const scanners = createScanners(deps.io, { cwd, scanners: deps.scanners, reportPath: deps.reportPath })
    const results = await Promise.all(scanners.map((scanner) => runScanner(scanner, target.request)))
    const plan = planScan({ ...target.request, results, known, now: at })
    await deps.store.append(plan.events)

    actions += plan.raised + plan.seen + plan.skipped
    actionsFailed += plan.failed
    hashes.push(plan.inputsHash)
  }

  return { actions, actionsFailed, inputsHash: shortHash({ targets: hashes }) }
}

/** The factory the daemon registers in place of §6's default `security-scan` body. */
export const createSecurityScanFactory = (wiring: SecurityWiring): RoutineFactory => (deps) => ({
  kind: 'security-scan',
  run: (context) => securityScanned({ ...wiring, read: deps.read }, context),
})
