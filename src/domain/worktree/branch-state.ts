/**
 * Does a worktree's branch say the worktree is still needed?
 *
 * This is the decision `fleet_branch_state` made with a dozen `git` calls interleaved
 * with the judgements. Gathering the facts is I/O (the Git port); deciding is not, so
 * the decision lives here and every wrinkle below has a unit test instead of needing a
 * real repo to reproduce.
 */

export type BranchState = "detached" | "open" | "merged" | "gone";

/** Everything the decision needs, read from git once (see WorktreeGitFacts in the Git port). */
export interface BranchFacts {
  /** The checked-out branch, or null for a detached HEAD (a peer's launch worktree). */
  readonly branch: string | null;
  /** `%(upstream)` of that branch: null or "" when it has none. */
  readonly upstream: string | null;
  /** `%(upstream:track)`, e.g. "[gone]" once the remote branch was deleted. */
  readonly upstreamTrack: string | null;
  /** Does `refs/remotes/origin/main` exist? Decides which main `merged` is measured against. */
  readonly hasOriginMain: boolean;
  readonly hasLocalMain: boolean;
  /** Is the branch already an ancestor of the base (a fast-forward merge)? */
  readonly branchMergedIntoBase: boolean;
  /** `git merge-base <base> <branch>`, null when they share no history. */
  readonly mergeBase: string | null;
  /** `git diff --name-only <mergeBase>..<branch>`: the files the branch touched. */
  readonly branchFiles: readonly string[];
  /** `git diff --name-only <base>..<branch>`: the files on which the branch and base differ. */
  readonly baseDifferingFiles: readonly string[];
}

/** An upstream of main itself is not a push of the branch (a `-b x origin/main` worktree tracks it). */
function tracksMainOnly(upstream: string | null): boolean {
  return upstream === null || upstream === "" || upstream === "refs/remotes/origin/main" || upstream === "refs/heads/main";
}

/**
 * One word, in this order:
 *
 * - `detached` — no branch to judge.
 * - `open` — never pushed, so kept whatever it holds. A brand-new branch with no commit
 *   of its own is an ancestor of main and would otherwise look merged, and its peer may
 *   be about to work in it.
 * - `merged` — main already holds it: an ancestor of main, or, after a squash merge,
 *   main has the branch's content on every file the branch touched (no file differs
 *   between base and branch). A repo with no remote therefore never reports this.
 * - `gone` — pushed, and the upstream no longer exists (deleted after its PR; needs a
 *   fetch --prune).
 * - `open` — pushed and not merged.
 */
export function branchState(facts: BranchFacts): BranchState {
  if (facts.branch === null || facts.branch === "") return "detached";
  if (tracksMainOnly(facts.upstream)) return "open";
  if (!facts.hasOriginMain && !facts.hasLocalMain) return "open";
  if (facts.branchMergedIntoBase) return "merged";

  if (facts.mergeBase !== null) {
    const touched = new Set(facts.branchFiles);
    const stillDiffering = facts.baseDifferingFiles.some((file) => touched.has(file));
    // Every file the branch touched already matches base: the change is in, squashed.
    if (touched.size > 0 && !stillDiffering) return "merged";
  }

  if ((facts.upstreamTrack ?? "").includes("gone")) return "gone";
  return "open";
}
