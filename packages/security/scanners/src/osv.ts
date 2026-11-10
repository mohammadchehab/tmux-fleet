/**
 * osv-scanner (§6.2): known-vulnerable dependencies, read from the lockfile.
 *
 * The lockfile *is* the dependency surface, so one scan of it covers every
 * ecosystem a repo has — `pnpm audit` would add nothing the OSV database does
 * not have, and would cover npm alone.
 *
 * A vulnerability's severity is OSV's own, which it states in
 * `database_specific.severity` only when the advisory's source does; CVSS
 * scores are the richer answer but mapping a vector to a word is a policy this
 * adapter should not invent, so an advisory with no severity word lands as
 * `medium` — reported, visible, not silently escalated past the gate.
 *
 * osv-scanner exits 1 when it finds something (its own convention, the one CI
 * overrides with a gate), so 1 is a clean run here.
 */

import type { Scanner, RawFinding } from '@fleet/security-findings'
import type { Severity } from '@fleet/foundation-contracts'
import { arrayOf, jsonOf, recordOf, relativize, runTool, severityFrom, stringOf, type ToolIo } from './report.ts'

/** OSV's words, plus the ones the database uses for the same bands. */
const severities: Readonly<Record<string, Severity>> = {
  critical: 'critical',
  high: 'high',
  moderate: 'medium',
  medium: 'medium',
  low: 'low',
  negligible: 'low',
}

export const parseOsv = (report: string, cwd = '.'): readonly RawFinding[] =>
  arrayOf(recordOf(jsonOf(report, 'osv-scanner')).results).flatMap((rawResult) => {
    const result = recordOf(rawResult)
    // The manifests the scan read. One result with no `source.path` still has
    // vulnerabilities, so the fallback is the lockfile name rather than nothing.
    const path = relativize(stringOf(recordOf(result.source).path) ?? 'unknown', cwd)

    return arrayOf(result.packages).flatMap((rawPackage) => {
      const pkg = recordOf(recordOf(rawPackage).package)
      const name = stringOf(pkg.name) ?? 'unknown'
      const version = stringOf(pkg.version) ?? '?'

      return arrayOf(recordOf(rawPackage).vulnerabilities).flatMap((rawVuln) => {
        const vuln = recordOf(rawVuln)
        const ruleId = stringOf(vuln.id)
        if (ruleId === undefined) return []
        const summary = stringOf(vuln.summary) ?? stringOf(vuln.details) ?? ruleId
        return [
          {
            ruleId,
            severity: severityFrom(severities, recordOf(vuln.database_specific).severity, 'medium'),
            path,
            // The message names the package, because "CVE-2024-1: prototype pollution"
            // does not say which of a hundred dependencies it is about.
            message: `${name}@${version}: ${summary}`,
          },
        ]
      })
    })
  })

export interface OsvOptions {
  readonly cwd: string
  /** The lockfiles to read. Defaults to the pnpm lockfile this workspace ships. */
  readonly lockfiles?: readonly string[]
}

export const createOsvScanner = (io: ToolIo, options: OsvOptions): Scanner => {
  const lockfiles = options.lockfiles ?? ['pnpm-lock.yaml']

  return {
    id: 'osv-scanner',
    scopes: ['diff', 'full'],
    async scan() {
      return runTool(
        {
          binary: 'osv-scanner',
          args: ['scan', ...lockfiles.flatMap((file) => ['--lockfile', file]), '--format', 'json'],
          cwd: options.cwd,
          // 1 is osv-scanner's "vulnerabilities found", with a report on stdout.
          exitCodes: [0, 1],
        },
        io,
        (report) => parseOsv(report, options.cwd),
      )
    },
  }
}
