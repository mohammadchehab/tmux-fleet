/**
 * One scan, as events (§6.2): outcomes in, the batch the routine appends out.
 *
 * The planner is a pure function of what the scanners reported and what the
 * `findings` projection already knows, for the same reason the PM's `decide`
 * is: a run that raised a finding can be replayed from its inputs, and a test
 * can prove the dedupe rule without a scanner installed.
 *
 * Three rules, all of them consequences of §6.2:
 *
 * 1. **A known fingerprint is `finding.seen`, not a second finding.** Line
 *    shifts must not multiply a finding; the row it names keeps its id.
 * 2. **A skip is recorded.** A tool that is not installed, does not apply, or
 *    broke leaves `scan.skipped` behind — the absence of coverage is a fact the
 *    fleet states, not one it forgets.
 * 3. **A tool that broke is an absence, counted as one.** It is recorded as a
 *    skip whose reason says it failed, and the plan counts it separately so the
 *    routine reports `actionsFailed` rather than a clean run (`ScanPlan.failed`).
 *    §6.2 has no `scan.failed` event; if a failed scan needs its own type, that
 *    is a contracts change to make deliberately, not to smuggle in here.
 *
 * The batch is sorted by fingerprint and by tool, so two scanners finishing in
 * the other order append the same events in the same order: a replay compares
 * equal, and a golden log does not drift.
 */

import type { AppendEvent, Severity } from '@fleet/foundation-contracts'
import { shortHash, type FindingId, type Timestamp } from '@fleet/foundation-core'
import { findingIdOf, fingerprintOf } from './fingerprint.ts'
import { toolNameOf, type RawFinding, type ScanOutcome, type ScanRequest, type Scanner } from './scanner.ts'

/** What one scanner answered in this run. */
export interface ScanResult {
  readonly scanner: Scanner
  readonly outcome: ScanOutcome
}

/** A fingerprint the `findings` projection already has, and the id it is filed under (§6.2). */
export interface KnownFinding {
  readonly fingerprint: string
  readonly findingId: FindingId
}

export interface PlanScanInput {
  readonly target: ScanRequest['target']
  readonly scope: ScanRequest['scope']
  readonly results: readonly ScanResult[]
  /** Every finding on file for this repository; the planner only needs the fingerprints. */
  readonly known?: readonly KnownFinding[]
  /** The instant the batch is stamped with, from the routine's injected clock (§5.4). */
  readonly now: Timestamp
}

export interface ScanPlan {
  /** The batch to append: `finding.raised`, `finding.seen` and `scan.skipped`, in a deterministic order. */
  readonly events: readonly AppendEvent[]
  readonly raised: number
  /** Findings this run saw again; they are a re-sight, not new work. */
  readonly seen: number
  /** Scanners that did not run, for any reason. */
  readonly skipped: number
  /** The subset of `skipped` where the tool failed rather than declined. */
  readonly failed: number
  /** The hash of what the scan read, so a run can be traced to a replayable decision (§5.4). */
  readonly inputsHash: string
}

const severityRank: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

/** A finding this run decided to raise, before it becomes an event. */
interface Raised {
  readonly fingerprint: string
  readonly scanner: Scanner
  readonly finding: RawFinding
}

const byFingerprint = (a: { readonly fingerprint: string }, b: { readonly fingerprint: string }): number =>
  a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0

const skipEvent = (input: PlanScanInput, tool: string, reason: string): AppendEvent => ({
  type: 'scan.skipped',
  ts: input.now,
  // The repository is the subject: a skip is about a place we did not look (§3).
  subject: input.target.repo,
  actor: 'scheduler',
  data: { repo: input.target.repo, sha: input.target.sha, tool, reason: reason.slice(0, 500) },
})

export const planScan = (input: PlanScanInput): ScanPlan => {
  const known = new Map<string, FindingId>((input.known ?? []).map((row) => [row.fingerprint, row.findingId]))
  const raise: Raised[] = []
  const seen: { readonly fingerprint: string; readonly findingId: FindingId }[] = []
  const events: AppendEvent[] = []
  let skipped = 0
  let failed = 0

  for (const result of input.results) {
    const tool = toolNameOf(result.scanner)
    const { outcome } = result

    if (outcome.status === 'skipped') {
      skipped += 1
      events.push(skipEvent(input, tool, outcome.reason))
      continue
    }
    if (outcome.status === 'failed') {
      // Counted as both a skip (no coverage) and a failure (it did not work).
      skipped += 1
      failed += 1
      events.push(skipEvent(input, tool, `failed: ${outcome.error}`))
      continue
    }

    for (const finding of outcome.findings) {
      const fingerprint = fingerprintOf(finding)
      const already = known.get(fingerprint)
      if (already !== undefined) {
        // Re-sighted: recorded once per run however many scanners report it.
        if (!seen.some((row) => row.fingerprint === fingerprint)) seen.push({ fingerprint, findingId: already })
        continue
      }
      // Two scanners in one run can cite the same rule and place; the first one
      // wins, and the duplicate is neither raised nor counted as seen.
      if (raise.some((row) => row.fingerprint === fingerprint)) continue
      raise.push({ fingerprint, scanner: result.scanner, finding })
    }
  }

  // Deterministic order: severity first (a critical finding is the one a human
  // reads first), then the fingerprint, so the batch does not depend on the
  // order the scanners happened to finish in.
  raise.sort((a, b) => severityRank[a.finding.severity] - severityRank[b.finding.severity] || byFingerprint(a, b))
  seen.sort(byFingerprint)

  for (const row of raise) {
    const { finding, scanner, fingerprint } = row
    events.push({
      type: 'finding.raised',
      ts: input.now,
      subject: findingIdOf(fingerprint),
      actor: 'scheduler',
      data: {
        findingId: findingIdOf(fingerprint),
        fingerprint,
        tool: toolNameOf(scanner),
        ruleId: finding.ruleId,
        severity: finding.severity,
        path: finding.path,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        message: finding.message.slice(0, 2000),
        sha: input.target.sha,
        ...(input.target.pr === undefined ? {} : { pr: input.target.pr }),
      },
    })
  }

  for (const row of seen) {
    events.push({
      type: 'finding.seen',
      ts: input.now,
      subject: row.findingId,
      actor: 'scheduler',
      data: { findingId: row.findingId, fingerprint: row.fingerprint, sha: input.target.sha },
    })
  }

  // What the scan read, for a run's `inputsHash`: the target, the scope, and
  // everything each tool reported — not only what was new, because "the same
  // scan twice" has to hash alike for a replay to mean anything (§5.4).
  const inputsHash = shortHash({
    repo: input.target.repo,
    sha: input.target.sha,
    pr: input.target.pr ?? null,
    scope: input.scope,
    results: input.results
      .map((result) => ({
        tool: toolNameOf(result.scanner),
        outcome:
          result.outcome.status === 'ok'
            ? result.outcome.findings.map((finding) => fingerprintOf(finding)).sort()
            : `${result.outcome.status}:${result.outcome.status === 'skipped' ? result.outcome.reason : result.outcome.error}`,
      }))
      .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0)),
  })

  return { events, raised: raise.length, seen: seen.length, skipped, failed, inputsHash }
}
