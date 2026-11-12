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
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fleetError } from '@fleet/foundation-core'

import { rpcCall } from '../api/server.ts'

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

/** How long an empty lock file is believed to be a fleetd mid-acquire: `wx` creates it, the pid is written a moment later. */
const EMPTY_LOCK_GRACE_MS = 2_000

/**
 * Which file is at `lockPath`. A replaced file is a different file whatever its
 * inode says — ext4 and tmpfs hand a just-freed inode number straight back — so
 * the identity is the inode, its times to the nanosecond, its size and what it
 * says. `mtimeMs` rides along only for the age of an empty lock.
 */
const identityOf = async (lockPath: string): Promise<{ readonly key: string; readonly mtimeMs: number } | undefined> => {
  try {
    const [exact, content] = await Promise.all([stat(lockPath, { bigint: true }), readFile(lockPath, 'utf8')])
    const key = [exact.dev, exact.ino, exact.mtimeNs, exact.ctimeNs, exact.size, content].map(String).join('|')
    return { key, mtimeMs: Number(exact.mtimeNs / 1_000_000n) }
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

/**
 * The locks this process wrote and has not released, as `<path>\0<pid>`. A pid is
 * unique among live processes, so a lock file naming *our* pid is either ours (it is in
 * here) or a crashed predecessor's that the kernel gave the same pid to — the usual
 * case after a reboot or a container restart over a persistent state volume. The pid
 * alone cannot tell the two apart; this can.
 */
const heldHere = new Set<string>()
const heldKey = (lockPath: string, pid: number): string => `${lockPath}\0${String(pid)}`

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

/** A takeover guard older than this is a fleetd that died mid-takeover, not one still deciding. */
const GUARD_STALE_MS = 10_000

/**
 * Remove the leftover at `lockPath` if it is still the file `judgedKey` describes, under a guard file created
 * `wx` beside it. Holding the guard serialises takeovers: a fleetd that judged the leftover before a rival's
 * takeover finds, once it holds the guard, the rival's fresh lock — a different identity — and leaves it alone.
 * `busy` means another fleetd holds the guard; refusing is recoverable, two daemons on one store is not.
 */
const takeOver = async (lockPath: string, judgedKey: string, pid: number): Promise<'removed' | 'changed' | 'busy'> => {
  const guardPath = `${lockPath}.takeover`
  let guard: Awaited<ReturnType<typeof open>>
  try {
    guard = await open(guardPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const held = await identityOf(guardPath)
    const owner = await pidIn(guardPath)
    const dead = held !== undefined && (owner === undefined ? Date.now() - held.mtimeMs > GUARD_STALE_MS : !alive(owner))
    // A guard whose owner is gone is cleared and the caller retries; anything else is somebody mid-takeover.
    if (dead) await rm(guardPath, { force: true })
    return 'busy'
  }
  try {
    await guard.writeFile(`${String(pid)}\n`, 'utf8')
    await guard.close()
    const now = await identityOf(lockPath)
    if (now === undefined || now.key !== judgedKey) return 'changed'
    await rm(lockPath, { force: true })
    return 'removed'
  } finally {
    await rm(guardPath, { force: true })
  }
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
      // The file the verdict below is about. Removing "the lock" afterwards would
      // remove whatever is there by then, and a rival fleetd that replaced a stale
      // file while this one was deciding has a live lock this one must not delete.
      const judged = await identityOf(lockPath)
      if (judged === undefined) continue
      const holder = await pidIn(lockPath)
      if (holder === undefined && Date.now() - judged.mtimeMs < EMPTY_LOCK_GRACE_MS) {
        throw fleetError('conflict', `the lock at ${lockPath} is being written by another fleetd; try again`, {
          details: { lockPath },
        })
      }
      if (holder !== undefined && alive(holder)) {
        // This very process is the holder: no evidence to gather, and taking
        // over its own lock would be handing it away. But only when it really is
        // its own: a file naming our pid that this process never wrote is a dead
        // predecessor's with a recycled pid, and refusing it would refuse every
        // restart until someone deleted the file by hand.
        const verdict =
          holder === pid ? (heldHere.has(heldKey(lockPath, pid)) ? 'fleetd' : 'not-fleetd') : await holderVerdict(holder, options)
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
      // Only one fleetd at a time may remove a leftover, and it re-checks the file *while holding that right*.
      // A bare check-then-`rm` leaves two awaits (stat, read) between a rival's check and its unlink, long enough
      // for another fleetd to remove the same leftover, create its own live lock, and have this one delete it.
      const taken = await takeOver(lockPath, judged.key, pid)
      if (taken === 'busy') {
        throw fleetError('conflict', `the lock at ${lockPath} is being taken over by another fleetd; try again`, {
          details: { lockPath },
        })
      }
      continue
    }

    try {
      await handle.writeFile(`${String(pid)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    heldHere.add(heldKey(lockPath, pid))

    return {
      path: lockPath,
      pid,
      async release() {
        heldHere.delete(heldKey(lockPath, pid))
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
