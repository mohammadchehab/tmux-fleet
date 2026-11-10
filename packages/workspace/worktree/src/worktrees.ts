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
 * **Which directory a path may name.** The path arrives from the `Worktree`
 * projection, and a port that deletes whatever string it is handed is a port that
 * deletes whatever a bad row says. So it is not taken on trust: git's own registry
 * is asked (`worktree list --porcelain`), and a path git does not list as a
 * checkout of the owning repository is a refusal. The registry is the containment,
 * not a directory prefix — §9 currently puts checkouts under `<repo>/.claude/
 * worktrees/`, but a layout is not something a port should assume, and git will
 * also refuse a path that is a plain file, a symlink out of the tree, or another
 * repository's checkout.
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

/** The checkouts git lists for the repository rooted at `root`, as absolute paths. */
const registered = async (runner: GitRunner, root: string): Promise<readonly string[]> => {
  const listed = await runner(['worktree', 'list', '--porcelain'], root)
  if (listed.code !== 0) {
    throw refused(`could not ask git which worktrees ${root} has`, listed)
  }
  return listed.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
}

export const createWorktrees = (runner: GitRunner = execFileGit): Worktrees => ({
  async remove(path) {
    // A relative path is resolved against whatever the daemon's cwd happens to be,
    // which is a second, silent answer to "which checkout". Only an absolute one.
    if (!path.startsWith('/')) throw new Error(`${path} is not an absolute path; no worktree was removed`)

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

    // Only a checkout git has registered for this repository may be removed. The
    // path came from a projection row; git's registry is what makes it a worktree
    // rather than a string.
    const known = await registered(runner, root)
    const wanted = path.replace(/\/+$/, '')
    if (!known.some((entry) => entry.replace(/\/+$/, '') === wanted)) {
      throw new Error(`${path} is not a worktree ${root} has; nothing was removed`)
    }

    const removed = await runner(['worktree', 'remove', path], root)
    if (removed.code !== 0) throw refused(`git refused to remove the worktree at ${path}`, removed)
  },
})
