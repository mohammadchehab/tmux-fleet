/**
 * Which ref is "the default branch" of the repository `cwd` belongs to (§9, §12.1).
 * Shared by the provisioner (where a new branch starts) and the file reader (what a
 * peer's standards are read from), because two answers to that question would put
 * a peer's branch and its rules on different commits.
 */

import type { GitRunner } from './git.ts'

/** The remote's default branch, else `origin/main`; `undefined` when neither exists. */
export const remoteDefault = async (runner: GitRunner, cwd: string): Promise<string | undefined> => {
  const head = await runner(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)
  if (head.code === 0 && head.stdout.trim() !== '') return head.stdout.trim()
  const main = await runner(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], cwd)
  return main.code === 0 ? 'origin/main' : undefined
}
