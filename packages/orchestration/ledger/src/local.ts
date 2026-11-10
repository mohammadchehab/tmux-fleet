/**
 * The local runner (§11): the box fleetd is on.
 *
 * Thin on purpose. Everything that makes a build a *ledger entry* — the dedupe,
 * the events, the host choice — belongs to `ledger.ts`; this file only turns a
 * command into an exit code and a log, so a test can assert on the ledger
 * without a process and on this without a ledger.
 */

import type { BuildRunner } from './runner.ts'
import { DEFAULT_BUILD_TIMEOUT_MS, spawnToLog, statusOf } from './runner.ts'

export interface LocalRunnerOptions {
  /** Injected so a test asserts the argv and the log path without spawning anything. */
  readonly process?: typeof spawnToLog
  /** Kill a build that runs longer than this. Defaults to `DEFAULT_BUILD_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

export const createLocalRunner = (options: LocalRunnerOptions = {}): BuildRunner => {
  const run = options.process ?? spawnToLog
  return {
    host: 'local',
    async run(build) {
      const outcome = await run({
        file: build.command.bin,
        args: build.command.args ?? [],
        env: build.command.env,
        cwd: build.command.cwd,
        logPath: build.logPath,
        stdoutPath: build.stdoutPath,
        timeoutMs: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      })
      return { status: statusOf(outcome.code), durationMs: outcome.durationMs, exitCode: outcome.code }
    },
  }
}
