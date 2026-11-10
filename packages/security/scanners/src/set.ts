/**
 * The scanner set a daemon runs (§6.2's table), built from one `cwd` and one
 * injected `ToolIo`.
 *
 * What is *not* here is the point: trivy is not in the default set, because
 * §6.2 runs it only where a repo has a Dockerfile, `deploy/` or `infra/`, and
 * the daemon is what knows the repo. Passing `scanners: ['trivy']` is how a
 * caller says "this one has something for it to read". A tool missing from the
 * host is still constructed: it answers `skipped` with a reason, which is the
 * record §6.2 wants, and building it costs a `which` that is only made when
 * the scan actually runs.
 */

import type { Scanner } from '@fleet/security-findings'
import { createGitleaksScanner } from './gitleaks.ts'
import { createOsvScanner } from './osv.ts'
import { createSemgrepScanner } from './semgrep.ts'
import { createTrivyScanner } from './trivy.ts'
import type { ToolIo } from './report.ts'

export const scannerIds = ['semgrep', 'gitleaks', 'osv-scanner', 'trivy'] as const
export type ScannerId = (typeof scannerIds)[number]

/** The tools §6.2 runs on every PR and nightly; trivy joins them only where it has something to read. */
export const defaultScannerIds: readonly ScannerId[] = ['semgrep', 'gitleaks', 'osv-scanner']

export interface ScannersOptions {
  /** The checkout to scan. */
  readonly cwd: string
  /** Which tools to run, in order. Defaults to `defaultScannerIds`. */
  readonly scanners?: readonly ScannerId[]
  /** The base a `diff` scan compares against, for semgrep and gitleaks. Defaults to `origin/main`. */
  readonly baseline?: string
  /** semgrep's rule sets. Defaults to `p/typescript` + `p/javascript`. */
  readonly semgrepConfig?: readonly string[]
  /** Lockfiles osv-scanner reads. Defaults to the workspace's pnpm lockfile. */
  readonly lockfiles?: readonly string[]
  /** Where gitleaks writes its report. Defaults to a unique path in the OS temp directory. */
  readonly reportPath: (name: string) => string
}

export const createScanners = (io: ToolIo, options: ScannersOptions): readonly Scanner[] =>
  (options.scanners ?? defaultScannerIds).map((id) => {
    switch (id) {
      case 'semgrep':
        return createSemgrepScanner(io, {
          cwd: options.cwd,
          ...(options.semgrepConfig === undefined ? {} : { config: options.semgrepConfig }),
          ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
        })
      case 'gitleaks':
        return createGitleaksScanner(io, {
          cwd: options.cwd,
          reportPath: options.reportPath,
          ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
        })
      case 'osv-scanner':
        return createOsvScanner(io, {
          cwd: options.cwd,
          ...(options.lockfiles === undefined ? {} : { lockfiles: options.lockfiles }),
        })
      case 'trivy':
        return createTrivyScanner(io, { cwd: options.cwd })
    }
  })
