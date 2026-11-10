/**
 * `BranchHead` over git (§6.2, §9): the commit `origin/<branch>` points at in a
 * checkout, after asking the remote.
 *
 * Why fetch first: the fleet's worktree was made for whatever work needed it, and
 * its `origin/main` is only as fresh as the last fetch there. A nightly scan that
 * read the stale ref would report on a commit that stopped being `main` days ago.
 * So the adapter fetches, then reads.
 *
 * Why a failed fetch is not fatal: the local ref may still name a real commit,
 * and scanning a known-but-old `main` beats scanning nothing at all. The caller
 * records that it scanned a particular sha; it never claims the sha was current.
 *
 * An unreadable ref is `undefined`, not a throw. A missing branch is a fact the
 * nightly scan records as a skip (§6.2), not an exception that fails a routine.
 */

import type { BranchHead } from '@fleet/foundation-contracts'
import type { Sha } from '@fleet/foundation-core'
import { execFileGit, type GitRunner } from './git.ts'

/** A commit as git prints it: abbreviated or full, lowercase hex. */
const SHA = /^[0-9a-f]{7,40}$/

export const createBranchHead = (runner: GitRunner = execFileGit): BranchHead => ({
  async head(cwd, branch) {
    // Best effort: refresh the remote-tracking ref so a nightly scan reads today's
    // `main`. A fetch that fails (offline, no remote) leaves the old ref in place.
    await runner(['fetch', '--quiet', 'origin', branch], cwd)

    const result = await runner(['rev-parse', `origin/${branch}`], cwd)
    if (result.code !== 0) return undefined
    const value = result.stdout.trim()
    return SHA.test(value) ? (value as Sha) : undefined
  },
})
