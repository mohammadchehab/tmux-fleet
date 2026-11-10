/**
 * The build ledger and the remote runner (§11), plus the eval task encoding that
 * makes §17's eval runs the ledger's first consumer.
 */

export { buildTaskClass, evalBuildTask, EVAL_TASK_CLASS, type EvalBuildIdentity } from './task.ts'
export { type BuildRouting, routeBuildHost, validateRouting } from './host.ts'
export {
  buildLogPath,
  spawnToLog,
  statusOf,
  type BuildCommand,
  type BuildRun,
  type BuildRunner,
  type BuildRunResult,
  type ProcessInvocation,
  type ProcessOutcome,
  type RunProcess,
} from './runner.ts'
export { createLocalRunner, type LocalRunnerOptions } from './local.ts'
export {
  createRemoteRunner,
  remoteArgv,
  remoteRepoDir,
  remoteScript,
  shellQuote,
  type RemoteRunnerOptions,
} from './remote.ts'
export {
  createBuildLedger,
  type BuildLedger,
  type BuildLedgerDeps,
  type BuildOutcome,
  type BuildRequest,
} from './ledger.ts'
