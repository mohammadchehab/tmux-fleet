/**
 * The `git` this package runs: one injected runner, no shell, resolved even on a
 * non-zero exit — the seam `@fleet/workspace-worktree` and the `gh` adapter use,
 * plus the one thing they do not need: stdin, because objects are written with
 * `hash-object --stdin` and `mktree` rather than through a working tree.
 */

import { execFile } from 'node:child_process'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface GitCall {
  readonly cwd: string
  /** Written to the process's stdin, which is closed after it. */
  readonly input?: string
}

export type GitRunner = (args: readonly string[], call: GitCall) => Promise<GitResult>

/**
 * A binary on `PATH`, run with argv and no shell, stdin written and closed.
 * Resolves on a non-zero exit too — the caller decides what a failure means —
 * so only a spawn that could not start is reported as a failure code.
 */
export const execFileTool =
  (binary: string, env: Readonly<Record<string, string>> = {}): GitRunner =>
  (args, call) =>
    new Promise((resolve) => {
      const child = execFile(
        binary,
        [...args],
        { cwd: call.cwd, timeout: 60_000, maxBuffer: 4 << 20, env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
            return
          }
          const code = typeof error.code === 'number' ? error.code : 1
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
        },
      )
      // A tool that exits before reading its input (`cat-file -e`, a refused push)
      // closes the pipe under the write. Its exit code already says what happened,
      // so the EPIPE is not a second failure — and unhandled it would crash fleetd.
      child.stdin?.on('error', () => {})
      child.stdin?.end(call.input)
    })

/**
 * `git` on `PATH`. Never prompts: a fleet polls unattended, so a missing
 * credential has to be a failed call, not a terminal waiting for a password.
 */
export const execFileGit: GitRunner = execFileTool('git', { GIT_TERMINAL_PROMPT: '0' })
