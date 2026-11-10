/**
 * The PR gate (architecture §10): the only thing in the fleet that merges.
 *
 * The PM never merges — it emits a `merge` action and the gate carries it out
 * (§5.2). That split is why this package exists at all: `orchestration/pm` is
 * pure and cannot see a branch, and an executor that merged on the PM's say-so
 * would be a second place §10 is decided. The gate decides on facts it reads
 * itself, right before it acts, and it reads them through the `PullRequests`
 * port — `apps/daemon` injects `integrations/github` (§1.1), so this package
 * holds no `gh` and no git, and a test is a fake port away.
 *
 * Four rules, and where each one lives:
 *
 * 1. **Green on the head sha the PM named.** `mergeRefusal` checks the pin
 *    before anything else, and the gate re-reads the PR after it has retargeted
 *    dependents and checks the pin again — retargeting is a write, and a head can
 *    move while it runs (§10).
 * 2. **A clean review.** §10's required review is, at this stage, the
 *    `approved` state of the PR the port reports. The merge-ownership policy —
 *    "with no reviewer role running the gate asks the user" — is not modelled
 *    here yet; this is the seam it will land on, and until then the gate refuses
 *    rather than stalls, which is the direction §10 asks for.
 * 3. **No unmerged stack parent.** A dependent is not mergeable while its
 *    parent is open; the parent is what the PM should be merging (§10).
 * 4. **Dependents first, and never their branch.** Before merging, every
 *    dependent is retargeted onto the base this PR is being merged into, and the
 *    merge itself is asked for without `deleteBranch` while any dependent
 *    exists — the `#102` loss was a `--delete-branch` that took a stack with it.
 *    The `merge` action cannot even ask for a delete (§5.4), so this is the only
 *    place that decision is made.
 *
 * Every action is attempted, in order, and a refusal is an `ActionOutcome` with
 * `ok: false` and a sentence — never a throw. A tick that threw would lose the
 * rest of its actions, which is the same reason the executor port is shaped the
 * way it is (§5.2).
 */

import { systemClock, toFleetError, type Clock, type Seq, type Sha } from '@fleet/foundation-core'
import type {
  ActionExecutor,
  ActionOutcome,
  AppendEvent,
  EventSink,
  ExecuteRequest,
  ExecutionReport,
  MergeAction,
  PmAction,
  PullRequest,
  PullRequestRef,
  PullRequests,
  RetargetAction,
} from '@fleet/foundation-contracts'
import { describeMergeRefusal, mergeRefusal } from './preconditions.ts'

export * from './preconditions.ts'

export interface GateDeps {
  /** §10's surface over `gh` and git; `apps/daemon` injects `integrations/github` (§1.1). */
  readonly pullRequests: PullRequests
  /** Where the gate's events go: `pr.retargeted` and `pr.merged` (§3). */
  readonly store: EventSink
  /** Injected so a test pins the timestamp the events carry (§5.4). */
  readonly clock?: Clock
  /**
   * Delete a merged PR's branch when nothing sits on it. Off by default: a
   * merged branch costs nothing, and the `#102` loss was a delete that raced a
   * dependent (§10). A profile may turn it on; the dependent check still runs.
   */
  readonly deleteMergedBranches?: boolean
}

export interface Gate extends ActionExecutor {
  /** The kinds this executor carries out; the daemon routes the rest elsewhere (§5.2). */
  readonly kinds: readonly PmAction['kind'][]
  /** One `merge` action, with §10's preconditions applied. Exposed for the scheduler and for tests. */
  executeMerge(action: MergeAction): Promise<ActionOutcome>
  /** One `retarget` action. Idempotent: a PR already on the base is a success with no events. */
  executeRetarget(action: RetargetAction): Promise<ActionOutcome>
}

const GATE_KINDS: readonly PmAction['kind'][] = ['merge', 'retarget']

const ref = (pr: PullRequestRef): string => `${String(pr.repo)}#${String(pr.number)}`
const at = (pr: PullRequest): PullRequestRef => ({ repo: pr.repo, number: pr.number })

export const createGate = (deps: GateDeps): Gate => {
  const clock = deps.clock ?? systemClock
  const deleteMergedBranches = deps.deleteMergedBranches ?? false

  /**
   * Append what an action caused. Returns the seqs, or the sentence to fail
   * the action with: the events are the record (§3), so a store that refuses
   * them is a failure of the action, not a detail to log and forget.
   */
  const append = async (events: readonly AppendEvent[]): Promise<{ readonly seqs: readonly Seq[] } | { readonly error: string }> => {
    if (events.length === 0) return { seqs: [] }
    try {
      return { seqs: await deps.store.append(events) }
    } catch (thrown) {
      return { error: toFleetError(thrown, 'store_failed').message }
    }
  }

  const failed = (action: PmAction, error: string): ActionOutcome => ({ action, ok: false, seqs: [], error })
  const done = (action: PmAction, seqs: readonly Seq[]): ActionOutcome => ({ action, ok: true, seqs })

  /** The PR as the port sees it now, or the sentence to fail with. Both actions fail the same way on a missing one. */
  const read = async (
    action: MergeAction | RetargetAction,
  ): Promise<{ readonly pr: PullRequest } | { readonly error: string }> => {
    try {
      const pr = await deps.pullRequests.get(action.pr.repo, action.pr.number)
      if (pr === undefined) return { error: `${ref(action.pr)} is not a pull request the gate can read` }
      return { pr }
    } catch (thrown) {
      return { error: toFleetError(thrown, 'provider_failed').message }
    }
  }

  const executeRetarget = async (action: RetargetAction): Promise<ActionOutcome> => {
    const current = await read(action)
    if ('error' in current) return failed(action, current.error)
    const { pr } = current

    if (pr.merged) return failed(action, `${ref(action.pr)} is already merged; there is nothing to retarget`)
    // Idempotent on purpose: the gate retargets a merge's dependents itself, so the PM's own `retarget` for the
    // same PR can arrive on a later tick and must not be recorded as a failure.
    if (pr.base === action.toBase) return done(action, [])

    try {
      await deps.pullRequests.retarget(action.pr.repo, action.pr.number, action.toBase)
    } catch (thrown) {
      return failed(action, toFleetError(thrown, 'provider_failed').message)
    }

    // Written only after the port accepted the move: a retarget that failed is not an event (§3).
    const written = await append([
      {
        type: 'pr.retargeted',
        ts: clock.now(),
        subject: ref(action.pr),
        actor: 'pm',
        causedBy: action.causedBy,
        data: { pr: action.pr, fromBase: pr.base, toBase: action.toBase },
      },
    ])
    if ('error' in written) return failed(action, written.error)
    return done(action, written.seqs)
  }

  /**
   * Move every dependent onto `base`, recording each move as it happens. A
   * dependent the port cannot read, or cannot retarget, blocks the merge: the
   * point is that the branch it sits on survives, and a stack we cannot see is
   * not one we can promise to keep (§10).
   *
   * Each `pr.retargeted` is appended right after the port accepted that one
   * move, so a merge refused later — a head that moved, a store that failed —
   * leaves a record of the moves that really happened. A retarget is a fact
   * about the repo before it is a step of the merge.
   */
  const retargetDependents = async (
    action: MergeAction,
    base: string,
  ): Promise<{ readonly seqs: readonly Seq[]; readonly moved: number } | { readonly error: string }> => {
    const seqs: Seq[] = []
    let moved = 0
    try {
      const dependents = await deps.pullRequests.dependents(action.pr.repo, action.pr.number)
      for (const dependent of dependents) {
        const where = ref(dependent)
        const pr = await deps.pullRequests.get(dependent.repo, dependent.number)
        if (pr === undefined) {
          return { error: `${where} is a dependent that cannot be read; refusing to merge over it (§10)` }
        }
        if (pr.merged || pr.base === base) continue

        await deps.pullRequests.retarget(dependent.repo, dependent.number, base)
        const written = await append([
          {
            type: 'pr.retargeted',
            ts: clock.now(),
            subject: where,
            actor: 'pm',
            causedBy: action.causedBy,
            data: { pr: at(pr), fromBase: pr.base, toBase: base },
          },
        ])
        if ('error' in written) return { error: written.error }
        seqs.push(...written.seqs)
        moved += 1
      }
      return { seqs, moved }
    } catch (thrown) {
      return { error: `a dependent could not be moved onto ${base}: ${toFleetError(thrown, 'provider_failed').message}` }
    }
  }

  const executeMerge = async (action: MergeAction): Promise<ActionOutcome> => {
    const current = await read(action)
    if ('error' in current) return failed(action, current.error)
    const { pr } = current

    let parent: PullRequest | undefined
    if (pr.stackParent !== undefined) {
      try {
        parent = await deps.pullRequests.get(pr.stackParent.repo, pr.stackParent.number)
      } catch (thrown) {
        return failed(action, toFleetError(thrown, 'provider_failed').message)
      }
    }

    const facts = parent === undefined ? { pr } : { pr, parent }
    const refusal = mergeRefusal(action, facts)
    if (refusal !== undefined) return failed(action, describeMergeRefusal(refusal, action, facts))

    // §10: dependents move first, onto the base this PR is merging into. Anything that cannot move blocks the merge.
    const moved = await retargetDependents(action, pr.base)
    if ('error' in moved) return failed(action, moved.error)

    // The head can move while a retarget runs. Re-read and re-pin before the one call that cannot be undone.
    const after = await read(action)
    if ('error' in after) return failed(action, after.error)
    if (after.pr.headSha !== action.headSha) {
      return failed(action, describeMergeRefusal('head_moved', action, { pr: after.pr }))
    }
    if (after.pr.merged) return failed(action, describeMergeRefusal('already_merged', action, { pr: after.pr }))

    // Never a branch delete while a dependent exists (#102). The action cannot ask for one either (§5.4).
    const deleteBranch = deleteMergedBranches && moved.moved === 0 && pr.stackParent === undefined

    let mergeSha: Sha | undefined
    try {
      const merged = await deps.pullRequests.merge(action.pr.repo, action.pr.number, {
        method: action.method,
        deleteBranch,
      })
      mergeSha = merged.mergeSha
    } catch (thrown) {
      return failed(action, toFleetError(thrown, 'provider_failed').message)
    }

    const written = await append([
      {
        type: 'pr.merged',
        ts: clock.now(),
        subject: ref(action.pr),
        actor: 'pm',
        causedBy: action.causedBy,
        data: { pr: action.pr, headSha: action.headSha, ...(mergeSha === undefined ? {} : { mergeSha }) },
      },
    ])
    if ('error' in written) return failed(action, written.error)
    return done(action, [...moved.seqs, ...written.seqs])
  }

  const executeOne = async (action: PmAction): Promise<ActionOutcome> => {
    switch (action.kind) {
      case 'merge':
        return executeMerge(action)
      case 'retarget':
        return executeRetarget(action)
      default:
        // The daemon composes executors and routes by kind. A gate that silently ignored the rest would make a
        // mis-wiring look like a quiet tick, so it says so instead.
        return failed(action, `the gate does not execute '${action.kind}'; the daemon routes it to another executor (§5.2)`)
    }
  }

  const report = (outcomes: readonly ActionOutcome[]): ExecutionReport => ({
    outcomes,
    executed: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
  })

  return {
    kinds: GATE_KINDS,
    executeMerge,
    executeRetarget,
    async execute(request: ExecuteRequest): Promise<ExecutionReport> {
      const outcomes: ActionOutcome[] = []
      for (const action of request.actions) outcomes.push(await executeOne(action))
      return report(outcomes)
    },
  }
}
