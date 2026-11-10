/**
 * The plumbing every adapter shares (§6.2): run the tool, decide whether it ran
 * at all, and read its report.
 *
 * Two rules are the point of this file. **A missing binary is a skip**, not a
 * failure — §6.2 lets a tool be absent and requires the absence be recorded, so
 * the adapter answers `skipped` and the router turns it into `scan.skipped`.
 * **A report we could not read is a failure**, not an empty scan: a tool that
 * exited badly and printed nothing found nothing *as far as we know*, and
 * "nothing found" is the most dangerous thing to guess.
 *
 * The JSON readers below are forgiving on purpose — a tool's output is an
 * external contract that changes between minor versions, so a field we cannot
 * read is dropped rather than thrown, and the finding still lands with what it
 * did carry.
 */

import type { RawFinding } from '@fleet/security-findings'
import type { Severity } from '@fleet/foundation-contracts'
import type { BinaryProbe, Exec, ExecResult, ReadFile } from './exec.ts'

/** What one adapter needs to run: the argv, the checkout, and which exits mean "it ran". */
export interface ToolRun {
  /** The program, as `PATH` names it. Also what `scan.skipped` records when it is absent. */
  readonly binary: string
  /** Args after the binary. Never a shell string: no quoting, no globbing. */
  readonly args: readonly string[]
  /** The checkout the tool reads. Paths in its report are resolved against it. */
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  /**
   * Exit codes that mean the scan ran. Non-zero is normal for a tool that found
   * something (osv-scanner exits 1 on a vulnerable file), which is why the
   * adapter states the set instead of testing `code === 0`.
   */
  readonly exitCodes: readonly number[]
  /** Set only when the tool writes its report to a file rather than stdout (gitleaks does). */
  readonly reportPath?: string
}

export interface ToolIo {
  readonly exec: Exec
  readonly has: BinaryProbe
  readonly readFile: ReadFile
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Enough of stderr to explain a failure in one `scan.skipped` reason. */
const tail = (stderr: string): string => stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)

/**
 * Run one tool and type its report. The three outcomes map onto §6.2's three:
 * `skipped` when the binary is absent, `failed` when it ran and broke, `ok`
 * with the parsed findings otherwise.
 */
export const runTool = async (
  run: ToolRun,
  io: ToolIo,
  parse: (report: string) => readonly RawFinding[],
): Promise<
  | { readonly status: 'ok'; readonly findings: readonly RawFinding[] }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: string }
> => {
  let installed: boolean
  try {
    installed = await io.has(run.binary)
  } catch {
    // `which` itself broke: we cannot say the tool is absent, and pretending it
    // is would hide a real problem behind a legitimate-looking skip.
    return { status: 'failed', error: `could not probe for ${run.binary}` }
  }
  if (!installed) return { status: 'skipped', reason: `${run.binary} is not installed` }

  let result: ExecResult
  try {
    result = await io.exec(run.binary, run.args, {
      cwd: run.cwd,
      ...(run.env === undefined ? {} : { env: run.env }),
    })
  } catch (error) {
    return { status: 'failed', error: `${run.binary}: ${messageOf(error)}` }
  }
  if (!run.exitCodes.includes(result.code)) {
    return { status: 'failed', error: `${run.binary} exited ${result.code}: ${tail(result.stderr) || 'no output'}` }
  }

  try {
    const report = run.reportPath === undefined ? result.stdout : await io.readFile(run.reportPath)
    return { status: 'ok', findings: parse(report) }
  } catch (error) {
    return { status: 'failed', error: `${run.binary}: ${messageOf(error)}` }
  }
}

// ---------------------------------------------------------- reading the report

export const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

export const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

export const lineOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

/** A tool's own severity word, through a map, with a floor for the labels we do not know. */
export const severityFrom = (
  table: Readonly<Record<string, Severity>>,
  raw: unknown,
  fallback: Severity,
): Severity => {
  const word = stringOf(raw)?.toLowerCase()
  return word === undefined ? fallback : (table[word] ?? fallback)
}

/**
 * A repository-relative path, which is what `finding.raised` requires
 * (`filePath()` refuses a leading slash). Tools are run with the checkout as
 * `cwd`, so most report relative paths already; a tool that resolves them fully
 * is stripped back down here.
 */
export const relativize = (path: string, cwd: string): string => {
  const trimmed = path.trim()
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  const relative = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
  return relative.startsWith('./') ? relative.slice(2) : relative
}

/** A report that is JSON, or a failure naming the tool — never a silent empty scan. */
export const jsonOf = (report: string, tool: string): unknown => {
  const text = report.trim()
  if (text === '') throw new Error(`${tool} printed no report`)
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${tool} did not print JSON: ${messageOf(error)}`)
  }
}
