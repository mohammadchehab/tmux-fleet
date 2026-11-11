/**
 * What a runner is, and the one piece of process plumbing both of them share
 * (§11).
 *
 * The ledger decides *whether* a build runs; a runner decides *how* it reaches a
 * host. There are two — the box fleetd is on, and the remote host over ssh — and
 * they differ in one argv, so the interface is the command and a log path.
 *
 * The process shape is injected for the reason `security/scanners/src/exec.ts`
 * gives for its own: no test spawns a build, and no CI box needs ssh. §1.1 lists
 * an `exec` shape as `foundation/core`'s; until it lands there a group holds its
 * own, because moving it is a `foundation` change.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { BuildCommand, BuildHost, BuildStatus } from '@fleet/foundation-contracts'
import type { Repo, Sha } from '@fleet/foundation-core'

/**
 * The command a build runs, as `foundation/contracts` spells it: the shape
 * crosses the socket, so it is declared once, there, and re-exported here as
 * part of what a runner takes.
 */
export type { BuildCommand } from '@fleet/foundation-contracts'

/** Everything a runner needs to attempt one build. */
export interface BuildRun {
  readonly buildId: string
  readonly repo: Repo
  readonly sha: Sha
  readonly task: string
  readonly command: BuildCommand
  /** Where stdout and stderr are kept: `artifacts/builds/<sha>-<task>.log` (§1.1). */
  readonly logPath: string
  /**
   * Where stdout is kept *beside* the log: `artifacts/builds/<sha>-<task>.out`.
   *
   * A build that answers with data — an eval run's JSON (§17) — needs its answer
   * apart from its narration, and the log carries both streams interleaved. The
   * log stays whole, because it is what a person tails; this is the same stdout
   * without the stderr a reader would otherwise have to strip.
   */
  readonly stdoutPath: string
}

export interface BuildRunResult {
  readonly status: BuildStatus
  readonly durationMs: number
  readonly exitCode: number | null
}

export interface BuildRunner {
  readonly host: BuildHost
  run(run: BuildRun): Promise<BuildRunResult>
}

/** One process, as the injected executor sees it. */
export interface ProcessInvocation {
  readonly file: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
  /** Both streams are written here (the file starts empty: a run owns its log), so a build is readable while it runs. */
  readonly logPath: string
  /** Stdout alone is written here as well, when a caller wants the answer without the narration. */
  readonly stdoutPath?: string
  /** Kill the process if it runs longer than this (milliseconds). */
  readonly timeoutMs?: number
}

export interface ProcessOutcome {
  readonly code: number | null
  readonly durationMs: number
}

/** Runs one program with argv, no shell. Only a spawn failure rejects; a non-zero exit resolves. */
export type RunProcess = (invocation: ProcessInvocation) => Promise<ProcessOutcome>

/**
 * How long a build may run before the runner kills it. A build that hangs holds its
 * key in the ledger's `inFlight` map, and every request for that `(repo, sha, task)`
 * waits on it, so "no limit" is not neutral: it is a build that blocks the next
 * caller for ever. An hour is above any build the fleet runs today; a profile's
 * `builds.timeoutMinutes` moves it.
 */
export const DEFAULT_BUILD_TIMEOUT_MS = 60 * 60_000

/** A path segment a log filename may carry: no `:` (a task's separator), no `/`. */
const slug = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'

/**
 * `artifacts/builds/<sha>-<task>-<hash>.log` (§1.1). The task is slugged rather than
 * quoted: a log path travels through a shell on the remote host, and a filename that
 * needs quoting is a filename that will one day not be quoted.
 *
 * A slug is lossy (`a-b:c` and `a:b-c` are one slug) and carries no repo, so the name
 * ends in a short hash of the whole key. Two builds that are different keys never share
 * a log, whatever their slugs; one build is always the same name, so a reclaimed run
 * finds (and, since `spawnToLog` truncates, replaces) its own.
 */
export const buildLogPath = (logDir: string, sha: Sha, task: string, repo: Repo): string => {
  const key = createHash('sha256').update(`${repo}\0${sha}\0${task}`).digest('hex').slice(0, 8)
  return join(logDir, `${slug(sha)}-${slug(task)}-${key}.log`)
}

/**
 * The error a build's own timeout raises. A build that ran too long ran, and its
 * answer is "too slow"; any other reason `run` threw is the *infrastructure* failing
 * (no such binary, a full disk), which says nothing about the commit.
 */
export const buildTimeoutError = (timeoutMs: number): Error =>
  Object.assign(new Error(`timeout: process exceeded ${timeoutMs}ms`), { name: 'BuildTimeoutError' })

export const isBuildTimeout = (error: unknown): boolean => error instanceof Error && error.name === 'BuildTimeoutError'

/** Exit code → what §11's `build.finished` records. A signal death is a failure, not a success. */
export const statusOf = (code: number | null): BuildStatus => (code === 0 ? 'succeeded' : 'failed')

/**
 * The real executor: `spawn`, both streams into the log, the exit code out. It
 * streams rather than buffering because a build log is what a person tails while
 * the build is still running, and a 64 MB `execFile` buffer would also cap how
 * much a failing build may say.
 */
export const spawnToLog: RunProcess = (invocation) => {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    let resolved = false
    const finish = (outcome: ProcessOutcome) => {
      if (resolved) return
      resolved = true
      resolve(outcome)
    }
    const fail = (error: Error) => {
      if (resolved) return
      resolved = true
      reject(error)
    }

    void mkdir(dirname(invocation.logPath), { recursive: true })
      .then(() => {
        const log = createWriteStream(invocation.logPath, { flags: 'w' })
        // The answer file is a copy of stdout, not a replacement for it: the log
        // stays the whole build, in order, for whoever reads it afterwards.
        const answer =
          invocation.stdoutPath === undefined ? undefined : createWriteStream(invocation.stdoutPath, { flags: 'w' })

        // Handle stream errors: EACCES, ENOSPC, etc.
        log.once('error', (error) => {
          killTree()
          answer?.destroy()
          fail(error)
        })
        answer?.once('error', (error) => {
          killTree()
          log.destroy()
          fail(error)
        })

        const env: NodeJS.ProcessEnv = { ...process.env }
        for (const [key, value] of Object.entries(invocation.env ?? {})) {
          if (value === undefined) delete env[key]
          else env[key] = value
        }
        const child = spawn(invocation.file, [...invocation.args], {
          cwd: invocation.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group, so a timeout can end what the build started and not
          // only the shell it started it through: a grandchild that holds the pipes open
          // would keep the build "running" after its leader was gone.
          detached: true,
        })
        const killTree = () => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }

        // Set up timeout if requested
        let timeoutHandle: NodeJS.Timeout | undefined
        if (invocation.timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            // The log is what a person reads to learn why a build ended; a kill with
            // no line in it looks like a build that simply stopped.
            log.write(`\nfleet: build timed out after ${invocation.timeoutMs}ms and was killed\n`)
            killTree()
            fail(buildTimeoutError(invocation.timeoutMs as number))
          }, invocation.timeoutMs)
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          log.write(chunk)
          answer?.write(chunk)
        })
        child.stderr?.pipe(log, { end: false })
        child.once('error', (error) => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          log.end(`${String(error)}\n`)
          answer?.end()
          fail(error)
        })
        child.once('close', (code) => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          log.end()
          answer?.end()
          finish({ code, durationMs: Date.now() - startedAt })
        })
      })
      .catch(fail)
  })
}
