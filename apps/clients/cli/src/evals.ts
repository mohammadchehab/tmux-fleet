/**
 * `fleet evals run <suite>`: ask the ledger for the run, and print what came back (§17).
 *
 * The suite runs as a *build* — the same ledger that runs tests runs evals, keyed on
 * `(repo, sha, task)` with `task` formed by `evalBuildTask` — which is what makes an
 * eval a heavy task that routes to the remote host by its class, and what makes an
 * identical run reuse the answer instead of paying for it twice. The CLI does not
 * spawn the suite and does not hold the ledger: it names the command, the daemon routes
 * and runs it, and the answer it reads afterwards is the file the ledger wrote.
 *
 * The contract with the suite is unchanged: one JSON object on stdout and an exit code.
 * What is new is that only stdout is the answer — the narration on stderr stays in the
 * build's log, which is also the only account of a run that never got as far as printing
 * anything.
 *
 * What the CLI *does* own is the printing: the shape comes back as JSON, is decoded
 * here (a file is not trusted more than a socket's), and goes out through
 * `evals-report.ts`, which is where the "no percentage under twenty cases" rule lives.
 */

import { readFile } from 'node:fs/promises'

import type { AppendEvent } from '@fleet/foundation-contracts'
import { fleetError, type EvalRunId } from '@fleet/foundation-core'

/** The suite's own report, decoded. Mirrors `EvalRunReport`, which is what prints it. */
export interface EvalsReport {
  /**
   * The run's name, folded in from the envelope: the suite describes its arithmetic,
   * and the id is the run's identity, not a fact the fold produced. It is here
   * because `EvalRunReport` is what `fleet evals compare` takes a run by.
   */
  readonly runId: EvalRunId
  readonly suite: string
  readonly provider: string
  readonly model: string
  readonly sha: string
  readonly cases: number
  readonly passed: number
  readonly tokens: { readonly input: number; readonly output: number }
  readonly latencyMs: readonly number[]
  readonly retries: number
  readonly costUsd?: number
}

/** One case that scored below its baseline, as the runner reported it. */
export interface EvalsRegression {
  readonly caseId: string
  readonly passes: number
  readonly attempts: number
  readonly baselinePasses: number
  readonly baselineAttempts: number
}

/** The verdict the run exits with. `saved` and `no-baseline` are both a pass. */
export type EvalsGate =
  | { readonly kind: 'no-baseline'; readonly exitCode: 0 }
  | { readonly kind: 'saved'; readonly exitCode: 0 }
  | { readonly kind: 'pass'; readonly exitCode: 0 }
  | { readonly kind: 'regressed'; readonly exitCode: 1; readonly regressions: readonly EvalsRegression[] }

/**
 * The `eval.*` rows the run is worth, as the runner handed them over. The CLI does
 * not build them — the fold from attempts to events belongs to `evals` — it only
 * sends them, in the two batches the store's citation rule asks for.
 */
export interface EvalsEvents {
  readonly started: AppendEvent
  readonly scored: readonly AppendEvent[]
  readonly finished: AppendEvent
}

export interface EvalsOutput {
  readonly runId: string
  readonly report: EvalsReport
  readonly gate: EvalsGate
  readonly baselinePath?: string
  readonly events: EvalsEvents
}

export interface EvalsRunOptions {
  readonly suite: string
  readonly provider: string
  readonly model: string
  /** Write this run as the new baseline instead of comparing against one. */
  readonly saveBaseline: boolean
  /** `FLEET_EVALS_BIN`, else `fleet-evals-judge` from `PATH`. */
  readonly bin?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** What the ledger runs: argv, never a shell line (§11's `BuildCommand`). */
export interface EvalsBuildCommand {
  readonly bin: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * The command `fleet evals run` asks the ledger to run, split out so a test can assert
 * on it without a daemon. The provider and the model travel as environment, which is the
 * contract the suite's promptfoo config already documents — one spelling, two drivers.
 *
 * Only those two variables cross the socket. The environment of the machine that typed
 * the command is none of the ledger's business, and a build's env on the remote host is
 * exported into a `sh` script, so copying `process.env` would ship whatever the caller
 * happens to have set — a token included.
 *
 * The bin is named for the suite — `fleet-evals-judge` for `judge` — so a suite says
 * what it can do in its own `package.json` and this file never grows a table of them.
 * `FLEET_EVALS_BIN` overrides that name for a checkout whose bins are not linked,
 * exactly as `FLEET_DAEMON_BIN` does for `fleetd`; it names the binary for the suite
 * being run, on whichever host runs it.
 */
export const evalsBuildCommand = (options: EvalsRunOptions): EvalsBuildCommand => {
  const env: Record<string, string> = { FLEET_EVAL_PROVIDER: options.provider, FLEET_EVAL_MODEL: options.model }
  return {
    bin: options.bin ?? options.env?.['FLEET_EVALS_BIN'] ?? `fleet-evals-${options.suite}`,
    args: options.saveBaseline ? ['--save-baseline'] : [],
    env,
  }
}

/**
 * Read the answer the ledger kept beside the build's log.
 *
 * A run that produced no answer file never got as far as printing one; the log is where
 * its narration and its error are, so the failure names the log rather than reporting a
 * missing file with nothing to look at.
 */
export const readEvalsAnswer = async (answerPath: string, logPath: string): Promise<string> => {
  try {
    return await readFile(answerPath, 'utf8')
  } catch (cause) {
    throw fleetError(
      'external_failed',
      (cause as NodeJS.ErrnoException).code === 'ENOENT'
        ? `the eval run left no answer in ${answerPath}; its log is at ${logPath}`
        : `cannot read the eval run's answer at ${answerPath}: ${(cause as Error).message}`,
      { cause, details: { answerPath, logPath } },
    )
  }
}

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fleetError('internal', `the ${path} of the eval run's answer is not an object`)
  }
  return value as Record<string, unknown>
}

const num = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw fleetError('internal', `the eval run reported ${path} as ${JSON.stringify(value)}, not a number`)
  }
  return value
}

const str = (value: unknown, path: string): string => {
  if (typeof value !== 'string') throw fleetError('internal', `the eval run reported ${path} as ${JSON.stringify(value)}, not a string`)
  return value
}

const numbers = (value: unknown, path: string): readonly number[] => {
  if (!Array.isArray(value)) throw fleetError('internal', `the eval run reported ${path} as ${JSON.stringify(value)}, not a list`)
  return value.map((one, index) => num(one, `${path}[${String(index)}]`))
}

const gateOf = (value: unknown): EvalsGate => {
  const root = record(value, 'gate')
  const kind = str(root['kind'], 'gate.kind')
  const exitCode = num(root['exitCode'], 'gate.exitCode')
  if (kind === 'regressed') {
    const rows = root['regressions']
    if (!Array.isArray(rows)) throw fleetError('internal', 'the eval run reported a regression with no cases')
    return {
      kind,
      exitCode: 1,
      regressions: rows.map((row, index) => {
        const at = `gate.regressions[${String(index)}]`
        const entry = record(row, at)
        return {
          caseId: str(entry['caseId'], `${at}.caseId`),
          passes: num(entry['passes'], `${at}.passes`),
          attempts: num(entry['attempts'], `${at}.attempts`),
          baselinePasses: num(entry['baselinePasses'], `${at}.baselinePasses`),
          baselineAttempts: num(entry['baselineAttempts'], `${at}.baselineAttempts`),
        }
      }),
    }
  }
  if (kind === 'pass' || kind === 'saved' || kind === 'no-baseline') return { kind, exitCode: 0 }
  throw fleetError('internal', `the eval run exited with an unknown verdict ${JSON.stringify(kind)}`)
}

/**
 * The rows are decoded as far as "an object with a `type`", not against the event
 * schemas: the daemon validates every one of them against its contract schema on
 * `events.append`, and a second, weaker copy of those rules here is how the two
 * drift apart.
 */
const eventOf = (value: unknown, path: string): AppendEvent => {
  const entry = record(value, path)
  if (typeof entry['type'] !== 'string') {
    throw fleetError('internal', `the eval run reported a row at ${path} with no event type`)
  }
  return entry as unknown as AppendEvent
}

const eventsOf = (value: unknown): EvalsEvents => {
  const root = record(value, 'events')
  const scored = root['scored']
  if (!Array.isArray(scored)) {
    throw fleetError('internal', 'the eval run reported no scored cases to append')
  }
  return {
    started: eventOf(root['started'], 'events.started'),
    scored: scored.map((one, index) => eventOf(one, `events.scored[${String(index)}]`)),
    finished: eventOf(root['finished'], 'events.finished'),
  }
}

/**
 * Decode the run's answer. The cheat is deliberate: `costUsd` is read only when it is
 * there, because "the provider does not report cost" is a fact the report prints as
 * `n/a` rather than as a free run (§17).
 */
export const readEvalsOutput = (body: string): EvalsOutput => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (cause) {
    throw fleetError('internal', `the eval run did not answer with JSON: ${(cause as Error).message}`, { cause })
  }
  const root = record(parsed, 'answer')
  const report = record(root['report'], 'report')
  const tokens = record(report['tokens'], 'report.tokens')
  const costUsd = report['costUsd']
  const baselinePath = root['baselinePath']
  return {
    runId: str(root['runId'], 'runId'),
    gate: gateOf(root['gate']),
    events: eventsOf(root['events']),
    ...(baselinePath === undefined ? {} : { baselinePath: str(baselinePath, 'baselinePath') }),
    report: {
      runId: str(root['runId'], 'runId') as EvalRunId,
      suite: str(report['suite'], 'report.suite'),
      provider: str(report['provider'], 'report.provider'),
      model: str(report['model'], 'report.model'),
      sha: str(report['sha'], 'report.sha'),
      cases: num(report['cases'], 'report.cases'),
      passed: num(report['passed'], 'report.passed'),
      tokens: {
        input: num(tokens['input'], 'report.tokens.input'),
        output: num(tokens['output'], 'report.tokens.output'),
      },
      latencyMs: numbers(report['latencyMs'], 'report.latencyMs'),
      retries: num(report['retries'], 'report.retries'),
      ...(typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}),
    },
  }
}
