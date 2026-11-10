/**
 * What kind of worktree is this, and does anything still need it?
 *
 * `fleet_wt_scan` mixed the gathering (git, du, lsof, the tmux panes) with this decision
 * in one 60-line shell function; here the decision takes the gathered row and answers.
 * The order of the tests below is the contract — first match wins — and every case is
 * pinned by a unit test.
 */

import type { BranchState } from "./branch-state.ts";

/** A peer's detached launch home, a normal topic branch, or one an opencode session made. */
export type WorktreeKind = "launch" | "topic" | "opencode";

export type WorktreeClass = "active" | "idle" | "merged" | "gone" | "orphaned" | "nested";

/** One scanned worktree: the TSV columns of the inventory, typed. */
export interface WorktreeRow {
  readonly profile: string;
  readonly repo: string;
  readonly path: string;
  /** The peer recorded when the worktree was made, or null. */
  readonly owner: string | null;
  readonly kind: WorktreeKind;
  /** The checked-out branch, or null when detached. */
  readonly branch: string | null;
  /** Gh's answer: "-" (not asked), "?" (no gh), "none", or "#12 merged". */
  readonly pr: string | null;
  /** Epoch seconds of the last commit or file change; 0 when unknown. */
  readonly lastChange: number;
  readonly dirty: number;
  readonly unpushed: number;
  readonly sizeKb: number | null;
  /** The peer whose pane sits in it, or null. */
  readonly inUse: string | null;
  readonly branchState: BranchState | null;
  /** The folder is gone, or git would prune the registration. */
  readonly missing: boolean;
}

export interface ScanContext {
  /** Peers of this profile that are running right now. */
  readonly runningPeers: readonly string[];
  /** Every worktree path in this scan, for the nesting test. */
  readonly allPaths: readonly string[];
  readonly idleDays: number;
  /** Epoch seconds, so the decision stays pure. */
  readonly now: number;
}

/** Is `child` strictly below `parent`? Trailing slashes are ignored, `/a/b` is not below `/a/bc`. */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return false;
  const base = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(base);
}

/** Days since the last change, rounded down, as the idle rule counts them. */
function idleDaysOf(lastChange: number, now: number): number {
  return Math.floor((now - lastChange) / 86_400);
}

export function classifyWorktree(row: WorktreeRow, context: ScanContext): WorktreeClass {
  const running = new Set(context.runningPeers);

  // Gone from disk, or registered but pruned: nothing to keep.
  if (row.missing) return "orphaned";

  // A launch worktree exists for its peer; with the peer gone so is the reason for it.
  if (row.kind === "launch" && (row.owner === null || !running.has(row.owner))) return "orphaned";

  // A topic worktree whose owner is not running — but only once we know the fleet is up,
  // because with the whole fleet down every owner looks absent.
  if (row.kind === "topic" && row.owner !== null && context.runningPeers.length > 0 && !running.has(row.owner)) {
    return "orphaned";
  }

  // An opencode worktree lives while something runs in it (a peer's pane, or a process a
  // prune protects); empty, it is orphaned.
  if (row.kind === "opencode" && row.inUse === null) return "orphaned";

  // Nested means another worktree physically contains this one: removing the outer one
  // would take this one with it.
  if (context.allPaths.some((other) => isInside(other, row.path))) return "nested";

  if (row.branchState === "merged" || row.branchState === "gone") return row.branchState;

  // A squash merge leaves no ancestry, and a repo that keeps branches leaves nothing gone:
  // the PR's own state is the only remaining evidence.
  if (row.pr !== null && row.pr.endsWith(" merged")) return "merged";

  // An unreadable age counts as 0, so a topic worktree git could not date falls to idle —
  // kept as the script had it: prune still refuses one that is dirty or unpushed.
  if (row.kind === "topic" && idleDaysOf(row.lastChange, context.now) >= context.idleDays) return "idle";

  return "active";
}
