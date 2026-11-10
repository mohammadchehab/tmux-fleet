/**
 * `RepoFiles` over git (§12.1): a file as the default branch has it, never as the
 * working tree does.
 *
 * `git show <sha>:<path>` rather than reading the file: the checkout a peer works
 * in can be edited by that peer, and what review approved is the commit. The sha
 * is resolved first and the file read at *that* sha, so the text and the `ref` the
 * caller records cannot come from two different commits if the branch moves
 * between the two calls.
 *
 * No fetch. The ref is as fresh as the last fetch in that checkout, which is the
 * same answer `git log origin/main` gives anyone standing there; the caller records
 * the sha, so a stale read is visible rather than silent.
 */

import type { RepoFiles } from '@fleet/foundation-contracts'
import { execFileGit, type GitRunner } from './git.ts'
import { remoteDefault } from './refs.ts'

const SHA = /^[0-9a-f]{40}$/

export const createRepoFiles = (runner: GitRunner = execFileGit): RepoFiles => ({
  async read(cwd, path) {
    // A path is a path *in the repository*: `..` or an absolute one would ask git
    // for something that is not the file the caller named.
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`'${path}' is not a path inside a repository`)
    }
    const base = await remoteDefault(runner, cwd)
    if (base === undefined) return undefined

    const resolved = await runner(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd)
    const ref = resolved.stdout.trim()
    if (resolved.code !== 0 || !SHA.test(ref)) return undefined

    const shown = await runner(['show', `${ref}:${path}`], cwd)
    // 128 is "no such path in that commit" (and "not a repository"): both are "nothing to read".
    return shown.code === 0 ? { text: shown.stdout, ref } : undefined
  },
})
