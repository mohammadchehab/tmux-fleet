/**
 * How a scanner adapter reaches the tool (§6.2): one `exec`, injected, so no
 * test spawns semgrep and no CI box installs trivy.
 *
 * §1.1 lists the `exec` shape as `foundation/core`'s. Until it lands there,
 * each group that runs a binary holds the same small shape — `notify/channels/macos`
 * and this package are the two — because groups do not import each other
 * sideways, and moving it is a `foundation` change, not one a group may make on
 * another group's behalf. The shape is deliberately the thinnest thing that
 * works: no shell, no streams, argv as an array.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface ExecOptions {
  readonly cwd?: string
  /** Extra environment; merged over the process's own, never a replacement for it. */
  readonly env?: Readonly<Record<string, string>>
}

/** Runs one program with argv, no shell. Resolves on a non-zero exit too; only a spawn failure is a rejection. */
export type Exec = (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>

export const execFileExec: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { maxBuffer: 64 << 20, cwd: options.cwd ?? process.cwd(), env: { ...process.env, ...options.env } },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
          return
        }
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
      },
    )
  })

/** Is a program on `PATH`? `which` answers through the same injected executor, so there is nothing else to fake. */
export type BinaryProbe = (binary: string) => Promise<boolean>

export const whichProbe =
  (exec: Exec): BinaryProbe =>
  async (binary) => {
    const result = await exec('/usr/bin/which', [binary])
    return result.code === 0
  }

/** Reading a report file a tool insists on writing itself (gitleaks writes `--report-path`, never stdout). */
export type ReadFile = (path: string) => Promise<string>

export const readFileNode: ReadFile = (path) => readFile(path, 'utf8')

/** Where a tool that needs an output path should write: unique per call, so two scans never read each other's report. */
export type TempPath = (name: string) => string

/**
 * A path in the OS temp directory, unique per call. Not inside the checkout:
 * a scan must not leave files in the tree it is judging, and two scanners
 * running concurrently must not read each other's report.
 */
export const tempPathNode: TempPath = (name) => join(tmpdir(), `fleet-${randomUUID()}-${name}`)
