/**
 * One fleetd per store (§2): a pid lock taken before the store is opened.
 *
 * The socket is not enough to answer "is a fleetd running". A daemon that
 * crashed leaves the socket file behind, and a daemon that has been told `down`
 * has closed its socket before its process has finished dying — both look
 * exactly like "nobody is running", and both give a second fleetd a store two
 * writers are about to interleave on. So the store gets a lock of its own, and
 * the answer is a pid, which can be asked whether it is still alive.
 *
 * A live pid is not the same as a live *fleetd*: after a reboot or a crash the
 * number can belong to anything at all, and a lock that refuses because some
 * unrelated process happens to hold that number is a fleet nobody can start
 * without deleting a file by hand. So a live holder is asked two questions
 * before it is believed — is a daemon answering on this fleet's socket, and does
 * the process look like `fleetd` — and taken over only when both say no.
 *
 * The file is created `wx`, so the create *is* the acquisition: two fleetds
 * racing for it cannot both win. A file whose pid is dead is not a lock any
 * more, only a leftover — it is taken over rather than refused, because the
 * alternative is a fleet that has to be cleaned up by hand after a crash.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fleetError } from '@fleet/foundation-core'

import { rpcCall } from './server.ts'

export interface FleetLock {
  readonly path: string
  /** The pid written into the file: the fleetd that holds it. */
  readonly pid: number
  /** Remove the file if it is still this holder's. Idempotent. */
  release(): Promise<void>
}

export interface FleetLockOptions {
  /** This daemon's pid. Defaults to `process.pid`. */
  readonly pid?: number
  /**
   * The fleet's socket (§2). A live fleetd answers here and names its own pid,
   * which is the one piece of evidence that a pid really is *this* fleet's
   * daemon rather than a number that has been handed to something else.
   */
  readonly socketPath?: string
  /** How the holder's command line is read. Defaults to `ps`; a test passes a reader. */
  readonly commandOf?: (pid: number) => string | undefined
  /** How a live daemon is asked who it is. Defaults to an `ls` over the socket. */
  readonly servedBy?: (socketPath: string, pid: number) => Promise<boolean>
}

/** `EPERM` is "running, but not yours", which is still running: only `ESRCH` means gone. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const pidIn = async (lockPath: string): Promise<number | undefined> => {
  try {
    const pid = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/**
 * The names `fleetd` runs under: the bin itself, and the entry point a checkout
 * runs directly (`FLEET_DAEMON_BIN=…/apps/daemon/src/main.ts`). A process that
 * matches neither is not this fleet's daemon, whatever its pid says.
 */
const FLEETD_COMMAND = /\bfleetd\b|apps[/\\]daemon[/\\]src[/\\]main\.ts/

/** How long a socket gets to answer before its pid is treated as not served. */
const SOCKET_PROBE_MS = 1_000

/** What the process at `pid` was launched as. `undefined` when `ps` cannot say. */
const commandOf = (pid: number): string | undefined => {
  const done = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  const command = done.stdout?.trim()
  return done.status === 0 && command !== undefined && command !== '' ? command : undefined
}

/**
 * Is a daemon answering on this fleet's socket, and is it the process the lock
 * names? The answer to both is what makes the pid a *fleetd* rather than a
 * number the kernel handed to something else after a reboot.
 *
 * Bounded: a socket that accepts and then says nothing must not turn `fleet up`
 * into a hang. Timing out means "not served", which falls through to the
 * command-line check — a fleetd that is that unwell is still refused there.
 */
const servedBy = async (socketPath: string, pid: number): Promise<boolean> => {
  const reply = await Promise.race([
    rpcCall(socketPath, { id: `lock-${String(Date.now())}`, method: 'ls' }).catch(() => undefined),
    new Promise<undefined>((resolve) => {
      setTimeout(() => {
        resolve(undefined)
      }, SOCKET_PROBE_MS).unref()
    }),
  ])
  if (reply === undefined || !reply.ok) return false
  const status = (reply.result as { status?: { pid?: unknown } }).status
  return status?.pid === pid
}

/** What the lock's holder turned out to be: a fleetd, demonstrably something else, or unreadable. */
type HolderVerdict = 'fleetd' | 'not-fleetd' | 'unknown'

/**
 * Three answers, in the order that stays safe when a question cannot be
 * answered: a daemon serving this fleet is a fleetd; a command line that reads
 * as `fleetd` is one too (it may still be booting, its socket not yet open); a
 * process that is neither is a recycled pid and takes over. A holder `ps` will
 * not describe is left alone — refusing a start is recoverable, two daemons on
 * one store is not.
 */
const holderVerdict = async (holder: number, options: FleetLockOptions): Promise<HolderVerdict> => {
  if (options.socketPath !== undefined) {
    const served = await (options.servedBy ?? servedBy)(options.socketPath, holder)
    if (served) return 'fleetd'
  }
  const command = (options.commandOf ?? commandOf)(holder)
  if (command === undefined) return 'unknown'
  return FLEETD_COMMAND.test(command) ? 'fleetd' : 'not-fleetd'
}

/**
 * Take the lock or refuse with `conflict`, naming the pid that holds it. Two
 * rounds at most: the second is the stale file being removed under us by a
 * fleetd starting at the same instant, and losing that race is a refusal, not a
 * retry loop.
 */
export const acquireFleetLock = async (lockPath: string, options: FleetLockOptions = {}): Promise<FleetLock> => {
  const pid = options.pid ?? process.pid
  await mkdir(dirname(lockPath), { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw fleetError('external_failed', `cannot take the fleet lock at ${lockPath}: ${(error as Error).message}`, {
          cause: error,
        })
      }
      const holder = await pidIn(lockPath)
      if (holder !== undefined && alive(holder)) {
        // This very process is the holder: no evidence to gather, and taking
        // over its own lock would be handing it away.
        const verdict = holder === pid ? 'fleetd' : await holderVerdict(holder, options)
        // The pid dying between the two reads is a leftover, not a holder: the
        // verdict is re-read rather than trusting evidence about a process that
        // was alive a moment ago.
        if (verdict !== 'not-fleetd' && alive(holder)) {
          throw fleetError(
            'conflict',
            verdict === 'fleetd'
              ? `this fleet already has a fleetd, pid ${String(holder)}; 'fleet down' stops it`
              : `the lock at ${lockPath} names pid ${String(holder)}, which is running but cannot be identified; if it is not a fleetd, delete the file`,
            { details: { pid: holder, lockPath } },
          )
        }
      }
      // No pid, a pid that is gone, or a live pid that is provably not a fleetd:
      // whoever wrote the file is not this fleet's daemon, so it is a leftover
      // and this fleetd is the one that takes over.
      await rm(lockPath, { force: true })
      continue
    }

    try {
      await handle.writeFile(`${String(pid)}\n`, 'utf8')
    } finally {
      await handle.close()
    }

    return {
      path: lockPath,
      pid,
      async release() {
        // Only if it is still ours: a lock a newer fleetd took over is not this
        // one's to remove, and removing it would hand the store to a third.
        if ((await pidIn(lockPath)) === pid) await rm(lockPath, { force: true })
      },
    }
  }

  throw fleetError('conflict', `this fleet's lock at ${lockPath} is being taken by another fleetd; try again`, {
    details: { lockPath },
  })
}
