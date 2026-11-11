/**
 * `branch-cleanup` (§6, §10): the fleet's branches are the fleet's to remove.
 *
 * A merge used to be the only moment a branch could go — `gh pr merge
 * --delete-branch`, asked for by the gate — and §10 has since taken that flag off
 * the merge action entirely (#102): a merge that deletes cannot be retried
 * without it, and a dependent that appears mid-merge is a branch someone still
 * sits on. The result was that nothing deleted anything, and one fleet left
 * seventy-six branches behind. So deletion became its own act, with its own pin
 * (§10's `head_moved`), and this body is what invokes it.
 *
 * **Two ways in, one rule.** A `work.merged` (or `pr.merged`) event wakes the
 * routine with the one branch it is about; the nightly schedule sweeps every repo
 * the profile names. Both delete only when the branch still points at a sha a
 * merge recorded, and both refuse to touch a branch something else is based on.
 *
 * - **A dependent blocks the delete, and then moves.** §10's rule is "no deletion
 *   while a dependent exists", not "never delete": a PR still open and based on
 *   this branch is retargeted onto the base the merge went into (§10's
 *   `retargetDependents`, performed here for the ones that appeared after the gate
 *   ran), and the branch goes only if nothing is based on it afterwards. A retarget
 *   that fails is a branch that stays, and a message that says why. The pin is
 *   asked first: a branch that moved past the merge is left alone, and its
 *   dependents are not moved off it.
 * - **Everything else is a person's decision.** A branch with commits after the
 *   merge, one whose PR was closed without merging, one the fleet has no PR for —
 *   the sweep never deletes those. It tells the owner, when there is one.
 * - **The checkout goes with the branch** (§9), and only when git would agree: a
 *   dirty or unpushed worktree, or one with a holder in it, is somebody's work in
 *   progress and is kept, with a message.
 *
 * The body appends through its own sink, for `pr-babysit`'s reason: `branch.deleted`
 * is the outcome of a wake, and waking on it would run this routine inside itself.
 * It carries the sha the branch pointed at, which is the whole point of recording
 * it — `git push <repo> <sha>:refs/heads/<branch>` puts the branch back.
 */

import { createHash } from 'node:crypto'
import { safeParse, workId as workIdShape, type Repo, type Sha, type Timestamp } from '@fleet/foundation-core'
import type {
  AppendEvent,
  EventSink,
  Mailbox,
  ForgePullRequest,
  PullRequest,
  PullRequestRef,
  PullRequests,
  ReadModel,
  WorkId,
  Worktree,
  Worktrees,
} from '@fleet/foundation-contracts'
import type { RoutineContext, RoutineOutcome } from '../routine.ts'

/**
 * What `branch-cleanup` needs that the scheduler does not hand a routine (§1.1):
 * the forge's port, the sink its facts go to, the box that reaches an owner and
 * §9's worktree manager. `apps/daemon` is the only place that has all four.
 */
export interface BranchCleanupDeps {
  /** The `PR` and `Worktree` projections, and the peers a message is written from (§3). */
  readonly read: ReadModel
  /** §10's port: what a remote holds, and the pinned delete. */
  readonly pullRequests: PullRequests
  /** The facts are this run's outcome, so they go to the store without waking (§6). */
  readonly store: EventSink
  /** §7's only way to a peer. Absent records the facts and tells nobody. */
  readonly mailbox?: Mailbox
  /** §9's manager, and the only thing that removes a checkout. Absent leaves worktrees alone. */
  readonly worktrees?: Worktrees
  /** The repos this fleet works in — the profile's `repos` (§2). */
  readonly repos: readonly Repo[]
}

/**
 * The names that are trunk in practice, used only as a fallback next to the one
 * the forge reports: a repo on `develop` or `release/2.x` is trunk under another
 * name, and a guard that knows two spellings fails open on every other.
 */
const trunkConventions: ReadonlySet<string> = new Set(['main', 'master'])

/**
 * Branches no merge may delete, whatever the log says. The sweep's rule already
 * refuses anything no merged PR owns; this is the guard against the case that
 * rule does not cover — a PR whose *head* is the repo's trunk — and against the
 * sweep retargeting work off trunk to make it deletable.
 *
 * The forge is asked for the default branch, and a forge that will not say is a
 * refusal: guessing it is the fail-open this guard exists to close.
 */
const protectedBranches = async (deps: BranchCleanupDeps, repo: Repo): Promise<BranchGuard> => {
  const names = new Set([...trunkConventions, await deps.pullRequests.defaultBranch(repo)])
  return { has: (branch) => names.has(branch) || longLived(branch) }
}

/** What the guard answers: is this branch one no merge may delete? */
interface BranchGuard {
  has(branch: string): boolean
}

/**
 * Long-lived integration branches: `develop`, `staging` and `release/*`. A release
 * PR is cut *from* one of these, so after it merges the branch is the head of a
 * merged PR whose sha still matches — exactly what the sweep deletes. It is the
 * line everyone keeps working on, not a topic branch the merge finished (TASK-90).
 */
const longLivedBranches: ReadonlySet<string> = new Set(['develop', 'staging'])
const longLived = (branch: string): boolean => longLivedBranches.has(branch) || branch.startsWith('release/')

/** A PR as every event names it: the repo and the number. */
const refOf = (pr: PullRequest): PullRequestRef => ({ repo: pr.repo, number: pr.number })

/** The one spelling of a PR in a subject or a message: `owner/repo#12`. */
const at = (ref: PullRequestRef): string => `${String(ref.repo)}#${String(ref.number)}`

/** The `inputsHash` a run records: the observations that produced its facts (§5.4). */
const hashOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

/**
 * The `workId` the projection holds as a brand, or nothing. A row whose `workId`
 * the contract would refuse is not one — dropped rather than thrown, for
 * `pr-babysit`'s reason: the branch is still a fact worth handling.
 */
const workIdOf = (value: string | undefined): WorkId | undefined => {
  if (value === undefined) return undefined
  const parsed = safeParse(workIdShape(), value)
  return parsed.ok ? parsed.value : undefined
}

interface Tally {
  readonly actions: number
  readonly failed: number
}

const none: Tally = { actions: 0, failed: 0 }

const plus = (left: Tally, right: Tally): Tally => ({
  actions: left.actions + right.actions,
  failed: left.failed + right.failed,
})

/**
 * One §7 message to the Work's assignee, delivered in the same run: a message
 * that waits for the next supervisor tick arrives after the branch it was about
 * had already moved on (`send_message` delivers too — §5.2, §7).
 *
 * `actions: 0` when there is nobody to tell: a branch with no Work has no owner,
 * and an invented recipient is worse than silence.
 */
const tell = async (deps: BranchCleanupDeps, workId: WorkId | undefined, body: string): Promise<Tally> => {
  const mailbox = deps.mailbox
  if (mailbox === undefined || workId === undefined) return none

  const work = await deps.read.work.get(workId)
  const to = work?.assignee
  if (to === undefined) return none

  const briefVersion = (await deps.read.peers.get(to))?.briefVersion
  if (briefVersion === undefined) return { actions: 1, failed: 1 }

  const sent = await mailbox.send({ to, from: 'scheduler', kind: 'nudge', briefVersion, body })
  if (!sent.ok) return { actions: 1, failed: 1 }

  const delivered = await mailbox.deliver(to)
  if (!delivered.ok) return { actions: 1, failed: 1 }
  const refused = delivered.value.failures.some((failure) => failure.msgId === sent.value)
  // It stays pending either way; the count is how a peer nobody can reach shows
  // up in `routine.finished` (§6, §7).
  return refused ? { actions: 1, failed: 1 } : { actions: 1, failed: 0 }
}

/**
 * §10's dependent rule, asked of the branch rather than of the merged PR: the
 * branch's own PR has just merged, so the question is whether anything else is
 * based on it. `list` and not the port's `dependents`, because a PR that appeared
 * after the merge has no `stackParent` pointing anywhere — its *base* is the fact.
 *
 * Only a PR that is neither merged nor closed is a dependent. A merged one is
 * history; one the forge says is `closed` was abandoned, and `gh` refuses to
 * retarget it — read as a dependent it was one that could never move, so the branch
 * under it was never deleted and its owner was told so every night (TASK-91). The
 * test is `closed` and not "not open" on purpose: an absent state is *unknown*,
 * never closed (`ForgePullRequest`), and an unknown row is still worth moving out
 * of the way.
 */
const basedOn = (read: readonly ForgePullRequest[], branch: string): readonly PullRequest[] =>
  read.filter((pr) => pr.base === branch && pr.merged === false && pr.state !== 'closed')

/**
 * Make the branch clear to delete: move whatever is based on it onto `base`, then
 * ask again. The second ask is the check that matters — a retarget that succeeded
 * is not the same fact as nothing being based on the branch, and §10's rule is the
 * latter. A dependent that will not move keeps the branch alive.
 */
const clearDependents = async (
  deps: BranchCleanupDeps,
  repo: Repo,
  branch: string,
  base: string,
  /**
   * The PRs the caller already read, in any state; `basedOn` is what decides which
   * of them are dependents. The sweep has them all, the event path has none and
   * asks the forge for the open ones.
   */
  known?: readonly ForgePullRequest[],
): Promise<{ readonly clear: true } | { readonly clear: false; readonly reason: string }> => {
  const open = known ?? (await deps.pullRequests.list(repo, { state: 'open' }))
  const dependents = basedOn(open, branch)
  for (const dependent of dependents) {
    try {
      await deps.pullRequests.retarget(dependent.repo, dependent.number, base)
    } catch (thrown) {
      const why = thrown instanceof Error ? thrown.message : String(thrown)
      return { clear: false, reason: `${at(refOf(dependent))} could not move onto ${base}: ${why}` }
    }
  }

  // Nothing was based on it: no second read, because a read that cannot change the
  // answer is one more `gh` call per branch per night.
  if (dependents.length === 0) return { clear: true }

  const left = basedOn(await deps.pullRequests.list(repo, { state: 'open' }), branch)
  if (left.length > 0) {
    return {
      clear: false,
      reason: `${left.map((pr) => at(refOf(pr))).join(', ')} ${left.length === 1 ? 'is' : 'are'} still based on ${branch}`,
    }
  }
  return { clear: true }
}

/**
 * §9's other half of the merge: the checkout of a Work whose PR merged goes, and
 * only when nothing in it is local-only. The projection already computed the two
 * facts that decide it — `dirty` and `unpushed` from git, `holders` from the
 * process scan — so this reads rather than re-runs them.
 */
const cleanWorktree = async (
  deps: BranchCleanupDeps,
  ts: Timestamp,
  repo: Repo,
  branch: string,
  workId: WorkId | undefined,
): Promise<Tally> => {
  const manager = deps.worktrees
  if (manager === undefined) return none

  const row: Worktree | undefined = (await deps.read.worktrees.all()).find(
    (entry) => entry.repo === repo && entry.branch === branch,
  )
  if (row === undefined) return none

  if (row.dirty || row.unpushed) {
    const what = row.dirty ? 'has uncommitted changes' : 'has commits that were never pushed'
    return tell(deps, workId, `The worktree at ${row.path} ${what}; it was kept.`)
  }
  if (row.holders.length > 0) {
    const who = row.holders.map((holder) => holder.command ?? String(holder.pid)).join(', ')
    return tell(deps, workId, `The worktree at ${row.path} is in use (${who}); it was kept.`)
  }

  try {
    await manager.remove(row.path)
  } catch (thrown) {
    const why = thrown instanceof Error ? thrown.message : String(thrown)
    return tell(deps, workId, `The worktree at ${row.path} could not be removed: ${why}`)
  }

  const batch: AppendEvent[] = [
    {
      ts,
      type: 'worktree.removed',
      subject: String(row.worktreeId),
      actor: 'scheduler',
      data: { worktreeId: row.worktreeId, reason: `its branch ${branch} was deleted after the merge` },
    },
  ]
  // §9: the Work is finished when its checkout is gone — but only a Work that **merged**
  // is finished, and `pr.merged` does not imply `work.merged`. `work-sync` turns one into
  // the other as a committed listener, and `wake.ts` wakes the scheduler *before* its
  // listeners run, so on the ordinary `pr.merged` wake the Work is still `mergeable` here.
  // Writing the transition anyway would be refused by the projector and record an anomaly
  // on the normal path; leaving it out costs nothing, because `worktree-gc` is woken by the
  // `work.merged` that follows and finishes the Work once the checkout is already gone.
  if (workId !== undefined && (await deps.read.work.get(workId))?.state === 'merged') {
    batch.push({
      ts,
      type: 'work.cleaned',
      subject: workId,
      actor: 'scheduler',
      data: { workId, worktreeId: row.worktreeId },
    })
  }
  await deps.store.append(batch)
  return { actions: 1, failed: 0 }
}

/**
 * Delete one branch, pinned, and record it. The pin is the merge's head sha: a
 * push that landed after the merge makes the delete refuse (`head_moved`), which
 * is a branch someone is still working on, not one to lose.
 *
 * The event is written after the delete and only for a delete that happened —
 * a log that claims a deletion the remote refused is worse than no log, because
 * it is the record someone would restore *from*.
 */
const deleteBranch = async (
  deps: BranchCleanupDeps,
  ts: Timestamp,
  repo: Repo,
  branch: string,
  sha: Sha,
  by: 'work.merged' | 'sweep',
  workId: WorkId | undefined,
): Promise<Tally> => {
  try {
    await deps.pullRequests.deleteBranch(repo, branch, sha)
  } catch (thrown) {
    const why = thrown instanceof Error ? thrown.message : String(thrown)
    return refuse(deps, repo, branch, why, workId)
  }

  await deps.store.append([
    {
      ts,
      type: 'branch.deleted',
      subject: `${String(repo)}:${branch}`,
      actor: 'scheduler',
      data: { repo, branch, sha, by },
    },
  ])
  return { actions: 1, failed: 0 }
}

/**
 * A deletion the fleet intended and could not carry out: a dependent it could not
 * move, a remote that refused the pin. It counts as a failed action — the run
 * decided to delete and did not — and the owner is told why.
 */
const refuse = async (
  deps: BranchCleanupDeps,
  repo: Repo,
  branch: string,
  reason: string,
  workId: WorkId | undefined,
): Promise<Tally> => {
  const told = await tell(deps, workId, `${String(repo)}'s ${branch} was not deleted: ${reason}.`)
  return { actions: told.actions, failed: 1 }
}

/**
 * A branch the rule never intended to delete, and why — the trunk, a PR closed
 * without merging, commits after the merge. Not a failure: the sweep deciding to
 * leave something alone is the sweep working.
 */
const explain = async (
  deps: BranchCleanupDeps,
  repo: Repo,
  branch: string,
  reason: string,
  workId: WorkId | undefined,
): Promise<Tally> => tell(deps, workId, `${String(repo)}'s ${branch} was left alone: ${reason}.`)

/** The PR row for a ref, from the projection first and the forge second. */
const rowFor = async (deps: BranchCleanupDeps, ref: PullRequestRef): Promise<PullRequest | undefined> => {
  const known = (await deps.read.pullRequests.all()).find(
    (row) => row.repo === ref.repo && row.number === ref.number,
  )
  return known ?? (await deps.pullRequests.get(ref.repo, ref.number))
}

/**
 * The merge event's half: the one branch this wake is about.
 *
 * `work.merged` and `pr.merged` carry the same two facts — the PR and the sha the
 * gate merged — and differ only in whether a Work is named. The sha from the event
 * is the pin, not the row's: the row may already have moved on (someone pushed to
 * the branch after the merge), and a delete pinned to a head nobody merged is a
 * delete of work nobody reviewed.
 */
const onMerge = async (deps: BranchCleanupDeps, context: RoutineContext): Promise<{ outcome: RoutineOutcome; observations: unknown }> => {
  const ts = context.clock.now()
  const event = context.event
  if (event === undefined) return { outcome: { actions: 0, actionsFailed: 0, inputsHash: hashOf({ event: 'none' }) }, observations: {} }

  const data = event.data as { pr?: PullRequestRef; headSha?: Sha; workId?: WorkId }
  const ref = data.pr
  if (ref === undefined) {
    return { outcome: { actions: 0, actionsFailed: 0, inputsHash: hashOf({ event: event.type, pr: 'none' }) }, observations: {} }
  }

  const row = await rowFor(deps, ref)
  const observations = { event: event.type, pr: at(ref), head: row?.head, rowSha: row?.headSha, eventSha: data.headSha }

  // The log says a merge; the row says a merge; neither is a branch this routine
  // may act on unless both agree it is merged and the projection knows the head.
  if (row === undefined || !row.merged) {
    return { outcome: { actions: 0, actionsFailed: 0, inputsHash: hashOf(observations) }, observations }
  }

  const branch = row.head
  const sha = data.headSha ?? row.headSha
  const workId = workIdOf(row.workId) ?? data.workId

  if ((await protectedBranches(deps, row.repo)).has(branch) || branch === row.base) {
    const refused = await explain(deps, row.repo, branch, `it is a trunk branch, and the fleet does not delete those`, workId)
    return { outcome: { actions: refused.actions, actionsFailed: refused.failed, inputsHash: hashOf(observations) }, observations }
  }

  // §10's pin, asked before anything is moved (TASK-92). A branch that moved past
  // the sha the merge recorded is one this wake will not delete, so its dependents
  // stay where they are: retargeting them first put stacked PRs on `main` under a
  // branch that then survived. The sweep asks the same question in the same order.
  // A branch the remote does not have at all is left to `deleteBranch` to report —
  // there is no head here to say it moved.
  const live = (await deps.pullRequests.branches(row.repo)).find((entry) => entry.name === branch)?.sha
  const seen = { ...observations, live }
  if (live !== undefined && live !== sha) {
    const refused = await refuse(
      deps,
      row.repo,
      branch,
      `it has commits after the merge (it is at ${String(live)}, not the merged ${String(sha)})`,
      workId,
    )
    return { outcome: { actions: refused.actions, actionsFailed: refused.failed, inputsHash: hashOf(seen) }, observations: seen }
  }

  const cleared = await clearDependents(deps, row.repo, branch, row.base)
  let tally: Tally

  if (!cleared.clear) {
    tally = await refuse(deps, row.repo, branch, cleared.reason, workId)
  } else {
    tally = await deleteBranch(deps, ts, row.repo, branch, sha, 'work.merged', workId)
    if (tally.failed === 0 && tally.actions === 1) {
      tally = plus(tally, await cleanWorktree(deps, ts, row.repo, branch, workId))
    }
  }

  return { outcome: { actions: tally.actions, actionsFailed: tally.failed, inputsHash: hashOf(seen) }, observations: seen }
}

/** A branch the sweep has decided about, before it acts. */

/** A branch the sweep has decided about, before it acts. */

/**
 * The nightly sweep's half: every branch in every repo the profile names, and the
 * one question that may delete it — does its head equal the head of a merged PR?
 *
 * Anything else is refused with a reason: a branch with commits after the merge,
 * a PR closed without merging, a branch the fleet has no PR for. The first two
 * have an owner to tell; the last has nobody, and the sweep says nothing rather
 * than inventing one.
 */
const sweep = async (deps: BranchCleanupDeps, context: RoutineContext): Promise<{ outcome: RoutineOutcome; observations: unknown }> => {
  const ts = context.clock.now()
  const observations: { repo: string; branch: string; sha: string; verdict: string }[] = []
  let tally: Tally = none

  for (const repo of deps.repos) {
    const all = await deps.pullRequests.list(repo, { state: 'all' })
    const trunk = await protectedBranches(deps, repo)
    const branches = [...(await deps.pullRequests.branches(repo))].sort((left, right) => left.name.localeCompare(right.name))

    for (const branch of branches) {
      const mine = all.filter((pr) => pr.head === branch.name)
      const merged = mine.filter((pr) => pr.merged)
      const owner = workIdOf(mine.find((pr) => pr.workId !== undefined)?.workId)

      if (trunk.has(branch.name)) {
        observations.push({ repo: String(repo), branch: branch.name, sha: String(branch.sha), verdict: 'trunk' })
        continue
      }

      if (merged.length === 0) {
        // No merged PR at all. Nothing to delete — but a PR closed without merging
        // is a person's abandoned branch, and its owner should hear once, not never.
        const verdict = mine.length === 0 ? 'no-pr' : 'closed-without-merge'
        observations.push({ repo: String(repo), branch: branch.name, sha: String(branch.sha), verdict })
        if (verdict === 'closed-without-merge') {
          tally = plus(
            tally,
            await explain(deps, repo, branch.name, `its PR was closed without merging, so nothing recorded a merge to delete it at`, owner),
          )
        }
        continue
      }

      // The pin the sweep offers: the head a merge recorded. A branch that moved
      // past it has work the merge never saw.
      const pinned = merged.find((pr) => pr.headSha === branch.sha)
      if (pinned === undefined) {
        observations.push({ repo: String(repo), branch: branch.name, sha: String(branch.sha), verdict: 'moved-after-merge' })
        tally = plus(
          tally,
          await explain(deps, repo, branch.name, `it has commits after the merge (its merged PR is at ${String(merged[0]?.headSha ?? 'an unrecorded sha')})`, owner),
        )
        continue
      }

      // Every PR the sweep read, closed ones included: `basedOn` is the one place
      // that says what a dependent is, so the two ways in cannot disagree (TASK-91).
      const cleared = await clearDependents(deps, repo, branch.name, pinned.base, all)
      if (!cleared.clear) {
        observations.push({ repo: String(repo), branch: branch.name, sha: String(branch.sha), verdict: 'dependent' })
        tally = plus(tally, await refuse(deps, repo, branch.name, cleared.reason, owner))
        continue
      }

      const deleted = await deleteBranch(deps, ts, repo, branch.name, branch.sha, 'sweep', owner)
      tally = plus(tally, deleted)
      // The same parity the merge path has: the checkout is the branch's, and a
      // branch that is still on the remote is a checkout someone may still use.
      const gone = deleted.failed === 0 && deleted.actions === 1
      observations.push({
        repo: String(repo),
        branch: branch.name,
        sha: String(branch.sha),
        verdict: gone ? 'deleted' : 'delete-failed',
      })
      if (gone) tally = plus(tally, await cleanWorktree(deps, ts, repo, branch.name, owner))
    }
  }

  return { outcome: { actions: tally.actions, actionsFailed: tally.failed, inputsHash: hashOf(observations) }, observations }
}

/**
 * One tick. An event wake cleans up the one branch it names; a scheduled wake
 * sweeps. The `PM` and the executor are ignored on purpose — this body decides no
 * action the PM planned, like `pr-babysit` and `notify` (§6).
 */
export const cleanup = async (deps: BranchCleanupDeps, context: RoutineContext): Promise<RoutineOutcome> => {
  const kind = context.event?.type
  const run = kind === 'work.merged' || kind === 'pr.merged' ? await onMerge(deps, context) : await sweep(deps, context)
  return run.outcome
}
