/**
 * The remote runner (§11): "heavy tasks route to the remote host (hetzner)".
 *
 * The remote host is reached over `ssh`, which is the one transport every fleet
 * box already has and the one that needs no agent, no listener and no new
 * credential. One `ssh <target> -- <script>`, the script does the checkout and
 * then `exec`s the command, and both streams come back on the same pipe — so the
 * log this writes is the log a local build writes, and nothing downstream has to
 * know which host answered.
 *
 * Three properties are deliberate:
 *
 * 1. **No shell on this side.** The command and its args are quoted into the
 *    script, never concatenated into a local shell string, so an argument with a
 *    space or a quote is an argument and not a second command.
 * 2. **BatchMode.** A build that stops to ask for a passphrase would hang fleetd
 *    until the socket closed. A host ssh cannot reach without prompting is a
 *    failed build with the reason in its log, which is what §11 wants a person
 *    to read.
 * 3. **The checkout pins the sha.** The ledger's uniqueness is on
 *    `(repo, sha, task)` (§11); a runner that built the branch head instead
 *    would make that key a lie. And it is the build's *own* tree — a detached
 *    worktree, installed from that sha's lockfile and removed afterwards — because
 *    the ledger coalesces only identical keys, so builds of other shas run at the
 *    same time and must not share a working directory.
 * 4. **The checkout's own bins are on PATH.** A workspace bin — `fleet-evals-judge`
 *    for one — is only on PATH inside the checkout that installed it, so a build
 *    that runs one would otherwise fail on the remote host for a reason that has
 *    nothing to do with the build. Prepending `node_modules/.bin` also means a
 *    build runs the tools its lockfile pins rather than the host's.
 */

import type { BuildRunner } from './runner.ts'
import { DEFAULT_BUILD_TIMEOUT_MS, spawnToLog, statusOf } from './runner.ts'

export interface RemoteRunnerOptions {
  /** The `ssh` target: a host, or a `~/.ssh/config` alias such as `hetzner`. */
  readonly target: string
  /** Where the repos live on the remote host (one directory each); builds get throwaway trees under `<root>/.builds`. */
  readonly root: string
  /** The repo's remote, as `git` sees it. Defaults to `origin`. */
  readonly remote?: string
  readonly process?: typeof spawnToLog
  /**
   * Kill the `ssh` of a build that runs longer than this. Its hang-up reaches the remote
   * script, whose trap removes the build's tree. Defaults to `DEFAULT_BUILD_TIMEOUT_MS`.
   */
  readonly timeoutMs?: number
}

/** A single argument as a POSIX shell sees it: quoted, so nothing in it is syntax. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The directory a repo is checked out in on the remote host. `owner/name`
 * becomes `owner-name`: one flat directory per repo, and the separator cannot
 * climb out of `root` because `/` does not survive it.
 */
export const remoteRepoDir = (repo: string): string => repo.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * The script the remote shell runs. Exported so a test can read it: this is
 * where the sha pin and the quoting live, and asserting on the argv around it
 * would not prove either.
 */
export const remoteScript = (
  options: Pick<RemoteRunnerOptions, 'root' | 'remote'>,
  build: { readonly repo: string; readonly sha: string; readonly command: { bin: string; args?: readonly string[]; env?: Readonly<Record<string, string | undefined>> } },
): string => {
  const remote = options.remote ?? 'origin'
  const dir = `${options.root}/${remoteRepoDir(build.repo)}`
  const exports = Object.entries(build.command.env ?? {}).flatMap(([key, value]) =>
    value === undefined ? [] : [`export ${key}=${shellQuote(value)}`],
  )
  const argv = [build.command.bin, ...(build.command.args ?? [])].map(shellQuote)
  const builds = `${options.root}/.builds`
  return [
    'set -e',
    `cd ${shellQuote(dir)}`,
    // The sha first: a PR head is often not on a branch, so a plain fetch would
    // not bring it. The fallback covers a server that refuses a sha fetch.
    `git fetch --quiet ${shellQuote(remote)} ${shellQuote(build.sha)} 2>/dev/null || git fetch --quiet ${shellQuote(remote)}`,
    // One tree per build. The repo directory is only the object store: two builds at
    // different shas would otherwise move the same working tree under each other, and
    // a result would describe whichever commit was checked out last.
    `mkdir -p ${shellQuote(builds)}`,
    `tree=$(mktemp -d ${shellQuote(`${builds}/XXXXXX`)})`,
    // Gone however the build ends — a failure, or ssh hanging up on a timeout — and a
    // path that git no longer knows is deleted all the same.
    `trap 'cd /; git -C ${shellQuote(dir)} worktree remove --force "$tree" >/dev/null 2>&1 || rm -rf "$tree"; git -C ${shellQuote(dir)} worktree prune' EXIT`,
    `trap 'exit 143' HUP INT TERM`,
    `git worktree add --quiet --detach "$tree" ${shellQuote(build.sha)}`,
    'cd "$tree"',
    // A fresh tree has no node_modules, and the lockfile of *this* sha decides what a
    // build runs on. Its output goes to the log: stdout is the build's answer.
    'if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --silent >&2; fi',
    // After the checkout, so a build sees the bins of the tree it is building; the
    // host's PATH stays behind them as a fallback for `git`, `ssh` and a shell.
    'export PATH="$tree/node_modules/.bin":"$PATH"',
    ...exports,
    // Not `exec`: the trap has to run after the command, and `set -e` hands its exit
    // code to the shell, so ssh still reports the build's own status.
    argv.join(' '),
  ].join('\n')
}

/** The argv this runner always uses; exported so a test asserts on it without a process. */
export const remoteArgv = (target: string, script: string): readonly string[] => [
  '-o',
  'BatchMode=yes',
  // A dead remote should fail the build in seconds, not hold the ledger open.
  '-o',
  'ConnectTimeout=20',
  target,
  '--',
  script,
]

export const createRemoteRunner = (options: RemoteRunnerOptions): BuildRunner => {
  const run = options.process ?? spawnToLog
  return {
    host: 'remote',
    async run(build) {
      const outcome = await run({
        file: 'ssh',
        args: remoteArgv(options.target, remoteScript(options, build)),
        logPath: build.logPath,
        // `ssh` keeps the remote's streams apart — its stdout is the command's
        // stdout and its stderr the command's stderr — so the answer file is
        // filled in on this side, by the same rule a local build follows.
        stdoutPath: build.stdoutPath,
        timeoutMs: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      })
      return { status: statusOf(outcome.code), durationMs: outcome.durationMs, exitCode: outcome.code }
    },
  }
}
