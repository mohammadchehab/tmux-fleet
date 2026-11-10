/**
 * gitleaks (§6.2): secrets in the diff and in the history.
 *
 * Two things make this adapter different from its siblings.
 *
 * **It writes a file, not stdout.** gitleaks only emits a report through
 * `--report-path`, so the adapter names one, and the caller supplies the path
 * and the reader — a temp file, unique per run, never inside the scanned
 * checkout (a scan must not dirty the tree it is judging).
 *
 * **The secret is never carried.** gitleaks reports `Secret` and `Match`; both
 * go to the log if they ride along, and a leaked secret in an event store is
 * the same leak with a longer half-life. The finding carries the rule, the
 * path and gitleaks' description instead, plus the leak's commit and line as
 * the snippet: §6.2's fingerprint is rule + path + snippet, so a re-run of the
 * same leak dedupes while a different secret of the same rule in the same file
 * is a finding of its own.
 *
 * `--exit-code 0` matches CI's reasoning: whether a finding blocks is the
 * fleet's decision, not each tool's own convention, so exit 1-with-a-report is
 * a clean run with findings, and only a real crash is a failure.
 */

import type { Scanner, ScanRequest, RawFinding } from '@fleet/security-findings'
import { arrayOf, jsonOf, lineOf, recordOf, relativize, runTool, stringOf, type ToolIo } from './report.ts'

/** A committed secret is high by default: gitleaks reports no severity of its own. */
const SECRET_SEVERITY = 'high' as const

/**
 * Where a leak sits: gitleaks' own `Fingerprint` (`commit:file:rule:line`), else
 * the commit and line it reports. Never `Secret` or `Match`.
 */
const locationOf = (leak: Record<string, unknown>, line: number | undefined): string | undefined => {
  const own = stringOf(leak.Fingerprint)
  if (own !== undefined) return own
  const commit = stringOf(leak.Commit)
  return commit === undefined && line === undefined ? undefined : `${commit ?? ''}:${line === undefined ? '' : String(line)}`
}

/** Parse gitleaks' JSON array. `Secret` and `Match` are deliberately not read. */
export const parseGitleaks = (report: string, cwd = '.'): readonly RawFinding[] =>
  arrayOf(jsonOf(report, 'gitleaks')).flatMap((raw) => {
    const leak = recordOf(raw)
    const path = stringOf(leak.File)
    const ruleId = stringOf(leak.RuleID)
    if (path === undefined || ruleId === undefined) return []
    const line = lineOf(leak.StartLine)
    const where = locationOf(leak, line)
    return [
      {
        ruleId,
        severity: SECRET_SEVERITY,
        path: relativize(path, cwd),
        ...(line === undefined ? {} : { line }),
        // The rule id is what a reader acts on; the description names the rule's
        // kind ("Generic API Key"). Neither is the secret.
        message: stringOf(leak.Description) ?? ruleId,
        // What tells two secrets of one rule in one file apart: the fleet's
        // fingerprint is rule + path + this, and the description is the same for
        // every hit of a rule. It is a place, never the secret.
        ...(where === undefined ? {} : { snippet: where }),
      },
    ]
  })

export interface GitleaksOptions {
  readonly cwd: string
  /** The base a `diff` scan's range starts from. Defaults to `origin/main`. */
  readonly baseline?: string
  /** Where the report is written. The caller owns the temp file, so tests do not touch disk. */
  readonly reportPath: (name: string) => string
}

/**
 * The range a scan walks. `HEAD` is the whole history, which is what a secret
 * needs: a key committed a year ago is still leaked (§6.2's nightly rule).
 */
const logOpts = (request: ScanRequest, baseline: string): string =>
  request.scope === 'diff' ? `${baseline}..HEAD` : 'HEAD'

export const createGitleaksScanner = (io: ToolIo, options: GitleaksOptions): Scanner => {
  const baseline = options.baseline ?? 'origin/main'

  return {
    id: 'gitleaks',
    scopes: ['diff', 'full'],
    async scan(request) {
      const reportPath = options.reportPath('gitleaks.json')
      // gitleaks writes no report file when there is nothing to report, so a
      // missing file is "no leaks", not a broken read; every other read error
      // still fails the scan.
      const ioForRun: ToolIo = {
        ...io,
        readFile: async (path) => {
          try {
            return await io.readFile(path)
          } catch (error) {
            if (recordOf(error).code === 'ENOENT') return '[]'
            throw error
          }
        },
      }
      return runTool(
        {
          binary: 'gitleaks',
          args: [
            'detect',
            '--source',
            '.',
            '--redact',
            '--no-banner',
            '--exit-code',
            '0',
            '--report-format',
            'json',
            '--report-path',
            reportPath,
            '--log-opts',
            logOpts(request, baseline),
          ],
          cwd: options.cwd,
          exitCodes: [0],
          reportPath,
        },
        ioForRun,
        (report) => parseGitleaks(report, options.cwd),
      )
    },
  }
}
