/**
 * trivy (§6.2): IaC and container misconfiguration, and image CVEs where a
 * repo has them.
 *
 * §6.2 runs this one only where the repo has something for it to read — a
 * Dockerfile, `deploy/`, `infra/` — so the daemon decides whether to construct
 * it at all; the adapter itself just scans a filesystem. `fs` mode is chosen
 * over `image` because the fleet is looking at a checkout, not a registry.
 *
 * `UNKNOWN` severity is reported as `info`: trivy is saying it has no rating,
 * and a "we do not know" that outranks nothing is still worth recording, but
 * not worth paging for.
 */

import type { Scanner, RawFinding } from '@fleet/security-findings'
import type { Severity } from '@fleet/foundation-contracts'
import { arrayOf, jsonOf, lineOf, recordOf, relativize, runTool, severityFrom, stringOf, type ToolIo } from './report.ts'

const severities: Readonly<Record<string, Severity>> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  unknown: 'info',
}

export const parseTrivy = (report: string, cwd = '.'): readonly RawFinding[] =>
  arrayOf(recordOf(jsonOf(report, 'trivy')).Results).flatMap((rawResult) => {
    const result = recordOf(rawResult)
    // A `Result` names what it read: a lockfile, a Dockerfile, a manifest.
    const path = relativize(stringOf(result.Target) ?? 'unknown', cwd)

    const vulnerabilities = arrayOf(result.Vulnerabilities).flatMap((raw) => {
      const vuln = recordOf(raw)
      const ruleId = stringOf(vuln.VulnerabilityID)
      if (ruleId === undefined) return []
      const pkg = stringOf(vuln.PkgName) ?? 'unknown'
      const installed = stringOf(vuln.InstalledVersion) ?? '?'
      return [
        {
          ruleId,
          severity: severityFrom(severities, vuln.Severity, 'medium'),
          path,
          message: `${pkg}@${installed}: ${stringOf(vuln.Title) ?? ruleId}`,
        },
      ]
    })

    const misconfigurations = arrayOf(result.Misconfigurations).flatMap((raw) => {
      const misconfig = recordOf(raw)
      const ruleId = stringOf(misconfig.ID)
      if (ruleId === undefined) return []
      const line = lineOf(recordOf(misconfig.CauseMetadata).StartLine)
      return [
        {
          ruleId,
          severity: severityFrom(severities, misconfig.Severity, 'medium'),
          path,
          ...(line === undefined ? {} : { line }),
          message: stringOf(misconfig.Title) ?? stringOf(misconfig.Description) ?? ruleId,
        },
      ]
    })

    return [...vulnerabilities, ...misconfigurations]
  })

export interface TrivyOptions {
  readonly cwd: string
}

export const createTrivyScanner = (io: ToolIo, options: TrivyOptions): Scanner => ({
  id: 'trivy',
  scopes: ['diff', 'full'],
  async scan() {
    return runTool(
      {
        binary: 'trivy',
        args: ['fs', '--format', 'json', '--quiet', '--scanners', 'vuln,misconfig', '.'],
        cwd: options.cwd,
        // trivy exits 0 unless asked to gate on findings; a non-zero exit is a broken scan.
        exitCodes: [0],
      },
      io,
      (report) => parseTrivy(report, options.cwd),
    )
  },
})
