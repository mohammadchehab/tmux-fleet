/**
 * `fleet evals run <suite>`: spawn the suite, and print what it says (§17).
 *
 * The CLI does not import `evals` — nothing outside it may (§1.1) — so the run is
 * a process, started the same way `fleet up` starts `fleetd`: by the bin name the
 * suite's own `package.json` declares, from `PATH`, with `FLEET_EVALS_BIN` naming
 * an absolute one for a checkout that is not linked.
 *
 * The contract is one JSON object on stdout and an exit code. `0` is a run that is
 * not worse than its baseline, `1` is one that is, `2` is a run that could not be
 * made — and the CLI passes all three through untouched, because a caller that
 * scripted this cares about the difference and the CLI has nothing to add to it.
 *
 * What the CLI *does* own is the printing: the shape comes back as JSON, is decoded
 * here (a child process's output is not trusted more than a socket's), and goes out
 * through `evals-report.ts`, which is where the "no percentage under twenty cases"
 * rule lives.
 */

import { spawn } from 'node:child_process'

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
  /** `claude` | `deepinfra`; the suite's own default when absent. */
  readonly provider?: string
  readonly model?: string
  /** Write this run as the new baseline instead of comparing against one. */
  readonly saveBaseline?: boolean
  /** `FLEET_EVALS_BIN`, else `fleet-evals-judge` from `PATH`. */
  readonly bin?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
}

export interface EvalsProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/**
 * The command `fleet evals run` runs, split out so a test can assert on it without
 * spawning anything. The provider and the model travel as environment, which is the
 * contract the suite's promptfoo config already documents — one spelling, two drivers.
 *
 * The bin is named for the suite — `fleet-evals-judge` for `judge` — so a suite says
 * what it can do in its own `package.json` and this file never grows a table of them.
 * `FLEET_EVALS_BIN` overrides that name for a checkout whose bins are not linked,
 * exactly as `FLEET_DAEMON_BIN` does for `fleetd`; it names the binary for the suite
 * being run.
 */
export const evalsCommand = (
  options: EvalsRunOptions,
): { readonly command: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv } => {
  // `spawn` replaces the environment rather than extending it, so the PATH the bin
  // is looked up on has to be carried over by hand.
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) env[key] = value
  }
  if (options.provider !== undefined) env['FLEET_EVAL_PROVIDER'] = options.provider
  if (options.model !== undefined) env['FLEET_EVAL_MODEL'] = options.model
  return {
    command: options.bin ?? options.env?.['FLEET_EVALS_BIN'] ?? `fleet-evals-${options.suite}`,
    args: options.saveBaseline === true ? ['--save-baseline'] : [],
    env,
  }
}

/**
 * Run one suite and collect what it said. The whole of stdout and stderr is kept:
 * stdout is the JSON the caller decodes, and stderr is the run's own narration,
 * which the CLI forwards rather than swallows — a baseline that was written, or the
 * cases that fell, are the lines a person reads.
 */
export const runEvals = (options: EvalsRunOptions): Promise<EvalsProcessResult> =>
  new Promise<EvalsProcessResult>((resolve, reject) => {
    const { command, args, env } = evalsCommand(options)
    const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn(command, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(
        fleetError('timeout', `the ${options.suite} eval run did not finish within ${String(timeoutMs)} ms`, {
          details: { command, timeoutMs },
        }),
      )
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        fleetError(
          'external_failed',
          error.code === 'ENOENT'
            ? `cannot run the ${options.suite} eval suite: "${command}" is not on PATH; run pnpm install in the fleet checkout, or set FLEET_EVALS_BIN`
            : `cannot run the ${options.suite} eval suite: ${error.message}`,
          { cause: error, details: { command } },
        ),
      )
    })
    child.once('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })
  })

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
