/**
 * The profiles this machine could be running (§7): a directory under
 * `~/.fleet` that has a daemon socket in it.
 *
 * A socket file is not proof of a live daemon — a crashed one leaves the file
 * behind — and this deliberately does not decide that. The first `ls` is what
 * proves it, and a socket that answers nothing is the same "no fleet running"
 * the tree already draws (§7). What this must get right is being cheap: it runs
 * on activation and whenever the tree is waiting for a fleet to appear, so it is
 * two reads per profile and no connections.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const isSocketFile = async (path: string): Promise<boolean> => {
  try {
    const info = await stat(path)
    return info.isSocket() || info.isFile()
  } catch {
    return false
  }
}

/** Profile names with a daemon socket, sorted: `['alpha', 'beta']`. Missing `~/.fleet` is an empty list. */
export const runningProfiles = async (home: string): Promise<readonly string[]> => {
  const root = join(home, '.fleet')
  let names: readonly string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }

  const found: string[] = []
  for (const name of names) {
    if (await isSocketFile(join(root, name, 'daemon', 'fleetd.sock'))) found.push(name)
  }
  return found.sort()
}
