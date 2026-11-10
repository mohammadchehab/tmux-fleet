/**
 * §9's `Worktrees` port over git: removing a checkout, and nothing else.
 *
 * `branch-cleanup` needs exactly one operation — the checkout of a Work whose PR
 * merged goes with its branch — and it must be git that decides whether it may:
 * `git worktree remove` without `--force` refuses a checkout holding changes, and
 * §9's rule ("nothing is deleted with local-only work") is then enforced twice,
 * by the projection the routine read and by the tool doing the removal. A forced
 * removal is not offered here on purpose; a caller that needs one is a caller
 * making a decision the design has not given anyone.
 *
 * **Which directory git runs in.** `git worktree remove` must be run from inside
 * the repository that owns the worktree, and the worktree itself is the one place
 * it cannot be run from — git refuses to remove the directory it is standing in.
 * §9 puts the checkout at `<repo>/.claude/worktrees/<topic>`, so the owning repo
 * is two paths up, but a layout is not something a port should assume. Instead
 * git is asked: `rev-parse --git-common-dir` from inside the worktree names the
 * main repository's git directory, and its parent is the directory to remove from.
 */

import type { Worktrees } from '@fleet/foundation-contracts'
import { execFileGit, type GitRunner } from './git.ts'

/** What a failed removal says, so the routine's message to an owner is worth reading. */
const refused = (what: string, result: { readonly stderr: string; readonly code: number }): Error =>
  new Error(`${what} (git exited ${String(result.code)}): ${result.stderr.trim() || 'no message'}`)

export const createWorktrees = (runner: GitRunner = execFileGit): Worktrees => ({
  async remove(path) {
    // The repository this checkout belongs to, asked of git rather than inferred
    // from where §9 says checkouts live.
    const common = await runner(['rev-parse', '--path-format=absolute', '--git-common-dir'], path)
    if (common.code !== 0) {
      throw new Error(`${path} is not a worktree git knows: ${common.stderr.trim() || 'no message'}`)
    }

    // `<repo>/.git` -> `<repo>`: the directory `worktree remove` has to run in.
    const gitDir = common.stdout.trim()
    if (gitDir === '') throw new Error(`git named no common directory for ${path}`)
    const root = gitDir.endsWith('/.git') ? gitDir.slice(0, -'/.git'.length) : gitDir

    const removed = await runner(['worktree', 'remove', path], root)
    if (removed.code !== 0) throw refused(`git refused to remove the worktree at ${path}`, removed)
  },
})
