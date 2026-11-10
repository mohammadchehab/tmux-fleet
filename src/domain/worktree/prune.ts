/**
 * Which worktrees may go, in what order, and what that frees.
 *
 * The script decided this while it removed things, with four nested shell loops doing
 * containment, double-counted sizes and "deepest first" ordering by hand. All of that is
 * a pure function of the scan, so it is here — which is also the only way it can be
 * tested: a dry run and a real one must agree, and a nested worktree must never be
 * counted twice.
 */

import { type WorktreeClass, type WorktreeKind, isInside } from "./classify.ts";
import { humanSize } from "./format.ts";

/** One scanned worktree, reduced to what a prune decides on. */
export interface PruneCandidate {
  readonly path: string;
  readonly klass: WorktreeClass;
  readonly kind: WorktreeKind;
  readonly owner: string | null;
  readonly branch: string | null;
  readonly dirty: number;
  readonly unpushed: number;
  /** The peer whose pane is in it, or null. */
  readonly inUse: string | null;
  /** Size in KiB; 0 when not measured. */
  readonly sizeKb: number;
  readonly missing: boolean;
}

export interface PruneRequest {
  /** Remove idle worktrees too (--idle). */
  readonly idle: boolean;
  /** Remove nested worktrees too (--nested). */
  readonly nested: boolean;
  /** The caller's directory: never remove the worktree it is standing in. */
  readonly cwd: string;
  /** Every process of this user and where it sits, so a peer on another tmux server still counts. */
  readonly processes: readonly { readonly pid: string; readonly cwd: string }[];
}

export type PruneDecision =
  /** Not a candidate under these flags. */
  | { readonly action: "skip" }
  /** The folder is gone; `git worktree prune` clears the registration. */
  | { readonly action: "prune-missing" }
  | { readonly action: "keep"; readonly why: string }
  | { readonly action: "remove" };

export interface PrunePlan {
  readonly decisions: readonly PruneDecision[];
  /** Each worktree's own size: the folder minus its direct nested worktrees. */
  readonly ownSizeKb: readonly number[];
  /** Indices to act on, deepest path first so a nested worktree goes before its host. */
  readonly order: readonly number[];
  readonly freedKb: number;
  readonly removed: number;
  readonly kept: number;
}

/** Would anything run in this folder if the worktree were removed? */
function processIn(candidate: PruneCandidate, request: PruneRequest): string | null {
  const hit = request.processes.find(
    (process) => process.cwd === candidate.path || isInside(candidate.path, process.cwd),
  );
  return hit === undefined ? null : `process ${hit.pid} is in it`;
}

/** The single reason, if any, this worktree must stay: first one wins, as printed. */
function keepReason(candidate: PruneCandidate, request: PruneRequest): string | null {
  if (candidate.dirty > 0) return `dirty: ${candidate.dirty} files`;
  if (candidate.unpushed > 0) return `${candidate.unpushed} unpushed commits`;
  if (candidate.inUse !== null) return `${candidate.inUse} is in it`;
  if (request.cwd === candidate.path || isInside(candidate.path, request.cwd)) return "it is your current directory";
  return processIn(candidate, request);
}

function decideOne(candidate: PruneCandidate, request: PruneRequest): PruneDecision {
  const { klass } = candidate;
  const wanted =
    klass === "merged" ||
    klass === "gone" ||
    klass === "orphaned" ||
    (klass === "idle" && request.idle) ||
    (klass === "nested" && request.nested);
  if (!wanted) return { action: "skip" };
  if (candidate.missing) return { action: "prune-missing" };

  const why = keepReason(candidate, request);
  return why === null ? { action: "remove" } : { action: "keep", why };
}

export function planPrune(candidates: readonly PruneCandidate[], request: PruneRequest): PrunePlan {
  const decisions: PruneDecision[] = candidates.map((candidate) => decideOne(candidate, request));

  // A worktree holding one that stays stays too: removing it would delete the nested one
  // with it. Containment is by path, so a grandparent sees a kept grandchild directly and
  // one pass is enough.
  for (let host = 0; host < candidates.length; host += 1) {
    if (decisions[host]?.action !== "remove") continue;
    const hostPath = candidates[host]?.path ?? "";
    for (let guest = 0; guest < candidates.length; guest += 1) {
      if (guest === host) continue;
      const guestDecision = decisions[guest];
      if (guestDecision === undefined || guestDecision.action === "remove" || guestDecision.action === "prune-missing") continue;
      const guestPath = candidates[guest]?.path ?? "";
      if (!isInside(hostPath, guestPath)) continue;

      const guestClass = candidates[guest]?.klass;
      const skipped = guestDecision.action === "skip" && (guestClass === "nested" || guestClass === "idle");
      decisions[host] = {
        action: "keep",
        why: `contains kept worktree ${guestPath}${skipped ? ` (${guestClass}; skipped without --${guestClass})` : ""}`,
      };
      break;
    }
  }

  // Own size: a removed folder's size minus the worktrees inside it, so nothing is
  // counted twice in the total freed.
  const ownSizeKb = candidates.map((candidate, index) => {
    if (decisions[index]?.action !== "remove") return candidate.sizeKb;
    let own = candidate.sizeKb;
    for (let guest = 0; guest < candidates.length; guest += 1) {
      const guestPath = candidates[guest]?.path ?? "";
      if (guest === index || !isInside(candidate.path, guestPath)) continue;
      // Only a direct child: one that has another worktree between us and it was already
      // subtracted as part of its own host.
      const nestedInBetween = candidates.some(
        (other, otherIndex) =>
          otherIndex !== index && otherIndex !== guest && isInside(other.path, guestPath) && isInside(candidate.path, other.path),
      );
      if (!nestedInBetween) own -= candidates[guest]?.sizeKb ?? 0;
    }
    return Math.max(own, 0);
  });

  const removed = decisions.filter((decision) => decision.action === "remove").length;
  const freedKb = decisions.reduce(
    (sum, decision, index) => (decision.action === "remove" ? sum + (ownSizeKb[index] ?? 0) : sum),
    0,
  );

  // Deepest first: a nested worktree has more separators in its path than its host, so it
  // is dealt with before the folder holding it. Everything is ordered, because the report
  // prints keeps in the same walk; the skipped rows say nothing.
  const order = candidates
    .map((candidate, index) => ({ index, depth: candidate.path.split("/").length }))
    .sort((left, right) => right.depth - left.depth || left.index - right.index)
    .map(({ index }) => index);

  return {
    decisions,
    ownSizeKb,
    order,
    freedKb,
    removed,
    kept: decisions.filter((decision) => decision.action === "keep").length,
  };
}

/**
 * The prune report, line for line as the script printed it — the shell tests match
 * `would remove …`, `keep … (<class>; <why>)` and the closing `freed … (N worktrees)`.
 * `applied` only changes the tense, so a dry run and the real run read the same.
 */
export function renderPruneReport(
  candidates: readonly PruneCandidate[],
  plan: PrunePlan,
  options: { readonly applied: boolean },
): string[] {
  const lines: string[] = [];
  for (const index of plan.order) {
    const candidate = candidates[index];
    const decision = plan.decisions[index];
    if (candidate === undefined || decision === undefined) continue;

    if (decision.action === "prune-missing") {
      lines.push(`${options.applied ? "prune" : "would prune"} ${candidate.path} (folder missing; git worktree prune)`);
    } else if (decision.action === "keep") {
      lines.push(`keep ${candidate.path} (${candidate.klass}; ${decision.why})`);
    } else if (decision.action === "remove") {
      const owner = candidate.owner === null || candidate.owner === "-" ? "" : `, ${candidate.owner}`;
      const branch = candidate.branch === null || candidate.branch === "-" ? "" : `, branch ${candidate.branch}`;
      const size = humanSize(plan.ownSizeKb[index] ?? null);
      lines.push(`${options.applied ? "removed" : "would remove"} ${candidate.path} (${candidate.klass}${owner}${branch}, ${size})`);
    }
  }

  const kept = plan.kept === 0 ? "" : `, kept ${plan.kept}`;
  lines.push(`${options.applied ? "freed" : "would free"} ${humanSize(plan.freedKb)} (${plan.removed} worktrees)${kept}`);
  return lines;
}
