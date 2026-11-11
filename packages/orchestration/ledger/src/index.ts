/**
 * The build ledger and the remote runner (§11). The spellings a caller and the ledger
 * share — `evalBuildTask`, `buildStdoutPath` — are in `@fleet/foundation-contracts`,
 * where the CLI can reach them (§1.1).
 */

export { buildTaskClass } from './task.ts'
export { type BuildRouting, routeBuildHost, validateRouting } from './host.ts'
export {
  buildLogPath,
  spawnToLog,
  statusOf,
  type BuildCommand,
  type BuildRun,
  type BuildRunner,
  type BuildRunResult,
  DEFAULT_BUILD_TIMEOUT_MS,
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
