/**
 * The `git` half of the workspace (§9): one injected runner, no shell, resolved
 * even on a non-zero exit — the same seam `@fleet/integrations-github` uses for
 * `gh`, for the same reason.
 *
 * §6.2's nightly scan has to ask git one question ("what does `origin/main` point
 * at?") and it must be able to answer it in a test without a repository. So the
 * package never calls `child_process` except through `execFileGit`, and every
 * test supplies its own `GitRunner` and asserts the argv.
 */

import { execFile } from 'node:child_process'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs `git` with argv in a directory, no shell. Resolves on a non-zero exit too
 * — the caller decides what a failure means — so only a spawn that could not
 * start is reported as a failure code rather than a rejected promise.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>

/** `git` on `PATH`. A missing binary surfaces as code 1 with the spawn message on stderr. */
export const execFileGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', [...args], { cwd, timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
        return
      }
      const code = typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
    })
  })
