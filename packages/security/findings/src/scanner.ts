/**
 * The `Scanner` port (§6.2): one adapter per tool, and the only thing the
 * `security-scan` routine knows about it.
 *
 * The shape is deliberately three-valued. A tool that is not installed, or that
 * does not apply to this repository, does not fail — it *skips*, and the
 * routine records that (`scan.skipped`): "we did not scan this" and "we scanned
 * it and found nothing" are different facts, and §6.2 makes silence a bug. A
 * tool that was skipped keeps a reason, so the gap is auditable.
 *
 * Adapters (`security/scanners`: semgrep, gitleaks, osv-scanner, trivy) do the
 * spawning and the JSON parsing; nothing here runs a process, so the routine's
 * rules are testable without any of them installed.
 */

import type { Repo, Sha } from '@fleet/foundation-core'
import type { PullRequestRef, Severity } from '@fleet/foundation-contracts'

/** What a scan looks at: one commit, and the PR it came from when it came from one (§6.2). */
export interface ScanTarget {
  readonly repo: Repo
  readonly sha: Sha
  readonly pr?: PullRequestRef
}

/** How much of the target a tool reads. `diff` is the PR's change, `full` the whole checkout. */
export const scanScopes = ['diff', 'full'] as const
export type ScanScope = (typeof scanScopes)[number]

export interface ScanRequest {
  readonly target: ScanTarget
  readonly scope: ScanScope
}

/**
 * What a tool reports, before the fleet types it. `snippet` is the cited code
 * when the tool gives it: it is what makes a fingerprint survive a line shift,
 * so an adapter that can produce one should (§6.2).
 */
export interface RawFinding {
  readonly ruleId: string
  readonly severity: Severity
  readonly path: string
  readonly line?: number
  readonly message: string
  readonly snippet?: string
}

export type ScanOutcome =
  | { readonly status: 'ok'; readonly findings: readonly RawFinding[] }
  /** Not applicable, not installed, or disabled by policy: recorded, never guessed at. */
  | { readonly status: 'skipped'; readonly reason: string }
  /** The tool ran and broke. The absence of a scan is still recorded (§6.2). */
  | { readonly status: 'failed'; readonly error: string }

export interface Scanner {
  /** The adapter's own name, unique in the set one routine runs: `semgrep`, `gitleaks`, … */
  readonly id: string
  /** The tool version/as invoked, when a skip or a finding records it. Defaults to `id`. */
  readonly tool?: string
  /** The scopes this tool is worth running in; the routine asks only for those (§6.2's cost table). */
  readonly scopes: readonly ScanScope[]
  scan(request: ScanRequest): Promise<ScanOutcome>
}

/** The tool name an event records for a scanner: its `tool`, or its `id`. */
export const toolNameOf = (scanner: Scanner): string => scanner.tool ?? scanner.id
