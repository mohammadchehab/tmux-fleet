/**
 * semgrep (§6.2): SAST over the checkout, JSON out.
 *
 * The argv mirrors `.github/workflows/security.yml`'s, which is the invocation
 * this repo actually proves daily: registry rule sets (`p/typescript` and
 * `p/javascript` by default), metrics off, no version check. A rule file in the
 * repository wins when one is passed, because a project's own rules are the
 * ones that know its sinks.
 *
 * `diff` scope asks semgrep to compare against a baseline commit rather than
 * re-report the whole tree. That needs the base in the checkout's history, so
 * an adapter run on a shallow clone has to be handed one (`baseline`), and the
 * daemon fetches before it scans (§6.2's "on the PR head SHA").
 */

import type { Scanner, ScanRequest, RawFinding } from '@fleet/security-findings'
import type { Severity } from '@fleet/foundation-contracts'
import { arrayOf, jsonOf, lineOf, recordOf, relativize, runTool, severityFrom, stringOf, type ToolIo } from './report.ts'

/** semgrep's three labels; it has no critical and no low. */
const severities: Readonly<Record<string, Severity>> = { error: 'high', warning: 'medium', info: 'info' }

export const defaultSemgrepConfigs = ['p/typescript', 'p/javascript'] as const

/** Parse semgrep's `--json` output. Exported so its shape is tested without a process. */
export const parseSemgrep = (report: string, cwd = '.'): readonly RawFinding[] =>
  arrayOf(recordOf(jsonOf(report, 'semgrep')).results).flatMap((raw) => {
    const result = recordOf(raw)
    const path = stringOf(result.path)
    const ruleId = stringOf(result.check_id)
    if (path === undefined || ruleId === undefined) return []
    const extra = recordOf(result.extra)
    const line = lineOf(recordOf(result.start).line)
    const snippet = stringOf(extra.lines)
    return [
      {
        ruleId,
        severity: severityFrom(severities, extra.severity, 'medium'),
        path: relativize(path, cwd),
        ...(line === undefined ? {} : { line }),
        message: stringOf(extra.message) ?? ruleId,
        ...(snippet === undefined ? {} : { snippet }),
      },
    ]
  })

export interface SemgrepOptions {
  /** The checkout to scan. Also what a report's absolute paths are made relative to. */
  readonly cwd: string
  /** Registry rule sets or paths to rule files. Defaults to `p/typescript` + `p/javascript`. */
  readonly config?: readonly string[]
  /** The commit a `diff` scan compares against. Defaults to `origin/main`. */
  readonly baseline?: string
}

export const createSemgrepScanner = (io: ToolIo, options: SemgrepOptions): Scanner => {
  const config = options.config ?? defaultSemgrepConfigs
  const baseline = options.baseline ?? 'origin/main'

  const argsFor = (request: ScanRequest): readonly string[] => [
    'scan',
    '--json',
    '--disable-version-check',
    '--exclude',
    'node_modules',
    ...config.flatMap((set) => ['--config', set]),
    ...(request.scope === 'diff' ? ['--baseline-commit', baseline] : []),
    '.',
  ]

  return {
    id: 'semgrep',
    scopes: ['diff', 'full'],
    async scan(request) {
      return runTool(
        {
          binary: 'semgrep',
          args: argsFor(request),
          cwd: options.cwd,
          env: { SEMGREP_SEND_METRICS: 'off' },
          exitCodes: [0],
        },
        io,
        (report) => parseSemgrep(report, options.cwd),
      )
    },
  }
}
