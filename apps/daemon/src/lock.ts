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
 * The file is created `wx`, so the create *is* the acquisition: two fleetds
 * racing for it cannot both win. A file whose pid is dead is not a lock any
 * more, only a leftover — it is taken over rather than refused, because the
 * alternative is a fleet that has to be cleaned up by hand after a crash.
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fleetError } from '@fleet/foundation-core'

export interface FleetLock {
  readonly path: string
  /** The pid written into the file: the fleetd that holds it. */
  readonly pid: number
  /** Remove the file if it is still this holder's. Idempotent. */
  release(): Promise<void>
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
 * Take the lock or refuse with `conflict`, naming the pid that holds it. Two
 * rounds at most: the second is the stale file being removed under us by a
 * fleetd starting at the same instant, and losing that race is a refusal, not a
 * retry loop.
 */
export const acquireFleetLock = async (lockPath: string, pid: number = process.pid): Promise<FleetLock> => {
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
        throw fleetError('conflict', `this fleet already has a fleetd, pid ${String(holder)}; 'fleet down' stops it`, {
          details: { pid: holder, lockPath },
        })
      }
      // No pid, or a pid that is gone: whoever wrote it is not running, so the
      // file is a leftover and this fleetd is the one that takes over.
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
