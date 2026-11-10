/**
 * One fleetd per store (§2).
 *
 * The socket cannot answer "is a fleetd running": a crash leaves the file, and a
 * daemon that has answered `down` closes the socket before its process is done
 * dying. Both look like nobody home, and both used to give a second fleetd a
 * store two writers were about to interleave on. So the answers tested here are
 * the lock's — a live holder is refused by pid, a dead one is taken over — and
 * then the two things the lock exists for: a second `up` does not start, and a
 * `down` gives the store back and ends the daemon.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { profilePaths } from '@fleet/foundation-core'

import { compose } from '../src/wiring/compose.ts'
import { acquireFleetLock } from '../src/wiring/lock.ts'
import { rpcCall } from '../src/api/server.ts'

const code = (thrown: unknown): string | undefined => (thrown as { code?: string }).code

/** A pid nothing is running under: a node that has already exited. */
const deadPid = (): number => {
  const done = spawnSync(process.execPath, ['-e', ''])
  assert.equal(done.status, 0)
  return done.pid
}

/** The profile a composed fleet needs; nothing in this file starts a peer. */
const PROFILE = `profile: locked
repos: [acme/widgets]
peers:
  - id: engineer-1
    role: engineer
    provider: claude
    model: claude-sonnet-5-5
`

const withHome = async (): Promise<string> => mkdtemp(join(tmpdir(), 'fleet-lock-'))

const writeProfile = async (home: string, name = 'locked'): Promise<void> => {
  const configHome = join(home, '.config')
  await mkdir(join(configHome, 'fleet', 'profiles'), { recursive: true })
  await writeFile(join(configHome, 'fleet', 'profiles', `${name}.yaml`), PROFILE, 'utf8')
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

describe('the store lock', () => {
  it('writes its pid, and gives the file back on release', async () => {
    const home = await withHome()
    try {
      const lock = await acquireFleetLock(join(home, 'daemon', 'fleetd.lock'))
      assert.equal((await readFile(lock.path, 'utf8')).trim(), String(process.pid))
      await lock.release()
      assert.equal(await exists(lock.path), false)
      // Idempotent: a shutdown path that releases twice is not an error.
      await lock.release()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a second fleetd while the holder is alive, naming its pid', async () => {
    const home = await withHome()
    try {
      const lock = await acquireFleetLock(join(home, 'daemon', 'fleetd.lock'))
      await assert.rejects(
        () => acquireFleetLock(lock.path),
        (thrown: unknown) =>
          code(thrown) === 'conflict' &&
          new RegExp(`already has a fleetd, pid ${String(process.pid)}`).test((thrown as Error).message),
      )
      await lock.release()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a lock whose pid is a live fleetd, even with no socket answering yet', async () => {
    const home = await withHome()
    try {
      const path = join(home, 'daemon', 'fleetd.lock')
      await mkdir(join(home, 'daemon'), { recursive: true })
      // A fleetd that has taken the lock but has not opened its socket yet: the
      // window the socket cannot answer for, and the one the command line can.
      await writeFile(path, `${String(process.ppid)}\n`, 'utf8')
      await assert.rejects(
        () => acquireFleetLock(path, { commandOf: () => `node /opt/fleet/bin/fleetd locked` }),
        (thrown: unknown) => code(thrown) === 'conflict' && /already has a fleetd/.test((thrown as Error).message),
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses while a live holder cannot be identified at all', async () => {
    const home = await withHome()
    try {
      const path = join(home, 'daemon', 'fleetd.lock')
      await mkdir(join(home, 'daemon'), { recursive: true })
      await writeFile(path, `${String(process.ppid)}\n`, 'utf8')
      // `ps` refused, another user's process on a locked-down host: the one case
      // where refusing is the safe answer, because taking over would put two
      // writers on the store if the holder did turn out to be a fleetd.
      await assert.rejects(
        () => acquireFleetLock(path, { commandOf: () => undefined }),
        (thrown: unknown) => code(thrown) === 'conflict' && /cannot be identified/.test((thrown as Error).message),
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('takes over a lock whose pid was recycled onto an unrelated live process', async () => {
    const home = await withHome()
    try {
      const path = join(home, 'daemon', 'fleetd.lock')
      await mkdir(join(home, 'daemon'), { recursive: true })
      // A live pid that is demonstrably not a fleetd: after a reboot the number
      // in the file can be anybody's, and refusing then is a fleet that cannot
      // start until someone deletes the lock by hand.
      const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
      try {
        assert.ok(stranger.pid !== undefined)
        await writeFile(path, `${String(stranger.pid)}\n`, 'utf8')
        const lock = await acquireFleetLock(path, { commandOf: () => `${process.execPath} -e setTimeout(() => {}, 60_000)` })
        assert.equal((await readFile(path, 'utf8')).trim(), String(process.pid))
        await lock.release()
      } finally {
        stranger.kill()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('takes over a lock naming a live process, reading the command line with `ps`', async (t) => {
    // Nothing injected: a real `ps` read of a real live process that is not
    // fleetd. Skipped, not failed, on a host whose `ps` will not describe a
    // process — the case the injected tests above already cover, and one where
    // the lock deliberately refuses rather than guessing.
    const probe = spawnSync('ps', ['-p', String(process.pid), '-o', 'command='], { encoding: 'utf8' })
    if (probe.status !== 0 || probe.stdout.trim() === '') {
      t.skip('`ps` cannot describe a process here')
      return
    }
    const home = await withHome()
    try {
      const path = join(home, 'daemon', 'fleetd.lock')
      await mkdir(join(home, 'daemon'), { recursive: true })
      const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
      try {
        assert.ok(stranger.pid !== undefined)
        await writeFile(path, `${String(stranger.pid)}\n`, 'utf8')
        const lock = await acquireFleetLock(path)
        assert.equal((await readFile(path, 'utf8')).trim(), String(process.pid))
        await lock.release()
      } finally {
        stranger.kill()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('takes over a lock left by a fleetd that is gone', async () => {
    const home = await withHome()
    try {
      const path = join(home, 'daemon', 'fleetd.lock')
      await mkdir(join(home, 'daemon'), { recursive: true })
      await writeFile(path, `${String(deadPid())}\n`, 'utf8')
      // The crash case: the file is a leftover, not a lock, and refusing here
      // would mean a fleet nobody can start without deleting it by hand.
      const lock = await acquireFleetLock(path)
      assert.equal((await readFile(path, 'utf8')).trim(), String(process.pid))
      await lock.release()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not remove a live fleetd’s lock that replaced the stale one while the takeover was deciding', async () => {
    const home = await withHome()
    try {
      const path = join(home, 'daemon', 'fleetd.lock')
      await mkdir(join(home, 'daemon'), { recursive: true })
      const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
      try {
        assert.ok(stranger.pid !== undefined)
        await writeFile(path, `${String(stranger.pid)}\n`, 'utf8')
        // The stale file is judged, and while it is, a rival fleetd takes the lock
        // the way the real one does: it removes the leftover and creates its own.
        let asked = 0
        const commandOf = (): string => {
          asked += 1
          if (asked > 1) return 'node /opt/fleet/bin/fleetd locked'
          spawnSync('rm', ['-f', path])
          spawnSync('sh', ['-c', `echo ${String(process.pid)} > ${path}`])
          return `${process.execPath} -e setTimeout(() => {}, 60_000)`
        }
        await assert.rejects(
          () => acquireFleetLock(path, { pid: deadPid(), commandOf }),
          (thrown) => code(thrown) === 'conflict',
        )
        assert.equal((await readFile(path, 'utf8')).trim(), String(process.pid), 'the rival’s fresh lock stays its own')
      } finally {
        stranger.kill()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a lock file that is still empty, because a fleetd is between creating it and writing its pid', async () => {
    const home = await withHome()
    try {
      const path = join(home, 'daemon', 'fleetd.lock')
      await mkdir(join(home, 'daemon'), { recursive: true })
      await writeFile(path, '', 'utf8')
      await assert.rejects(
        () => acquireFleetLock(path),
        (thrown) => code(thrown) === 'conflict',
      )
      assert.equal(await readFile(path, 'utf8'), '', 'the file a booting fleetd made is not a leftover')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('leaves a lock that has been taken over since it was acquired', async () => {
    const home = await withHome()
    try {
      const lock = await acquireFleetLock(join(home, 'daemon', 'fleetd.lock'))
      await writeFile(lock.path, `${String(deadPid())}\n`, 'utf8')
      await lock.release()
      assert.equal(await exists(lock.path), true, 'a newer fleetd’s lock is not this one’s to remove')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('a second fleetd on a store a live one holds', () => {
  it('is refused before it opens the store', async () => {
    const home = await withHome()
    try {
      await writeProfile(home)
      const composed = await compose({ profileName: 'locked', roots: { home } })
      try {
        await assert.rejects(
          () => compose({ profileName: 'locked', roots: { home } }),
          (thrown: unknown) => code(thrown) === 'conflict' && /already has a fleetd/.test((thrown as Error).message),
        )
      } finally {
        await composed.server.close()
        await composed.store.close()
        await composed.lock.release()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('`fleet down`', () => {
  it('gives the store back and ends the daemon, so the next up can start', async () => {
    const home = await withHome()
    try {
      await writeProfile(home)
      const paths = profilePaths('locked', { home })
      let ended = false
      const composed = await compose({ profileName: 'locked', roots: { home }, exit: () => { ended = true } })

      const answer = await rpcCall(paths.socketPath, { id: 'down-1', method: 'down' })
      assert.equal(answer.ok, true)
      assert.deepEqual(answer.ok ? answer.result : undefined, { stopped: true })

      // The exit is deferred past the response so the client reads it first.
      const deadline = Date.now() + 2_000
      while (!ended && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))

      assert.equal(ended, true, 'a daemon that answered `down` and stayed would hold the store')
      assert.equal(await exists(paths.lockPath), false)
      assert.equal(await exists(paths.socketPath), false)

      // The claim the lock exists to make: the store is startable again.
      const again = await compose({ profileName: 'locked', roots: { home }, exit: () => {} })
      await again.server.close()
      await again.store.close()
      await again.lock.release()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
