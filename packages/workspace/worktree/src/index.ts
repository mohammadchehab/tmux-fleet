/**
 * `@fleet/workspace-worktree` (§9): the checkouts peers work in.
 *
 * Today it is one thing — `BranchHead`, which lets §6.2's nightly scan name the
 * commit it is about to scan without inventing a projection for it.
 */

export * from './branch-head.ts'
export * from './git.ts'
