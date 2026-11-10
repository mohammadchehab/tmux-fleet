/**
 * `@fleet/workspace-worktree` (§9): the checkouts peers work in.
 *
 * Today it is two things, both read from the outside rather than owned here —
 * `BranchHead`, which lets §6.2's nightly scan name the commit it is about to
 * scan without inventing a projection for it, and `Worktrees`, the removal half
 * of §9's manager that `branch-cleanup` consults after a merge. Creation, class
 * and holders still belong to the daemon's own manager (§9); this package is the
 * `git` seam those will be built on.
 */

export * from './branch-head.ts'
export * from './git.ts'
export * from './worktrees.ts'
