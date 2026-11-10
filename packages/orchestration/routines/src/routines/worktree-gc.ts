/**
 * `worktree-gc` (§6, §9): the fleet's checkouts are the fleet's to take back, and
 * only when nothing in one is anybody's.
 *
 * §9 gives the manager the whole lifecycle — it creates every checkout, and it is
 * the only thing that deletes one. `branch-cleanup` (§10) owns the *branch* and,
 * as a side effect of deleting it, the checkout that belonged to it. This body is
 * the other half: a checkout whose Work is over and whose branch is gone, or was
 * never worth keeping, still sitting on disk. Nothing here deletes a branch, and
 * nothing here touches trunk: a checkout is not a ref, and a routine that confused
 * the two would be a second deleter §10 never asked for.
 *
 * **The rule is a conjunction, and each term is somebody's work.** A checkout goes
 * only when all three hold:
 *
 * 1. **Its PR is done** — merged, or closed without merging. In the closed case the
 *    branch is *left alone*: its Work was dropped rather than merged, and §10 gives
 *    the deletion of a branch its own pin and its own body. Only the checkout goes.
 * 2. **It is clean and pushed** (`!dirty && !unpushed`) — §9's one rule with no
 *    exception: "nothing is deleted with local-only work". A dirty or unpushed
 *    checkout is a person's afternoon, and the run tells its owner instead.
 * 3. **No live holder.** §9 records the processes whose cwd is inside a checkout
 *    so `gc` can *report* them, never kill them. A live one is somebody working, so
 *    the checkout stays and the owner is told. `Worktree.holders` is the last
 *    scan's answer, not proof of anything: between that scan and this run a peer
 *    may have exited, and a row full of `ESRCH` pids would keep a checkout forever.
 *    So liveness is re-asked at removal time, through an injected check, and a
 *    process that is gone is a leftover rather than a reason to keep.
 *
 * **Two ways in, one rule.** `work.merged`/`pr.merged` wakes the routine with the
 * one PR a merge is about — that names the branch, the branch names the checkout,
 * and only that checkout is considered. §6's daily 03:00 sweep considers every row
 * in the projection, which is how a checkout is collected while the daemon was
 * down for the merge, or after a PR was closed rather than merged (§3 has no
 * `pr.closed`, so "closed" is only knowable by asking the forge: a row the log
 * holds that the forge no longer lists as open is one nobody can still merge).
 *
 * The body appends through its own sink, for `pr-babysit`'s and `branch-cleanup`'s
 * reason: `worktree.removed` is the outcome of a wake, and waking on it would run
 * this routine inside itself.
 */

import { createHash } from 'node:crypto'
import { safeParse, workId as workIdShape, type Timestamp } from '@fleet/foundation-core'
import type {
  AppendEvent,
  EventSink,
  Mailbox,
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
 * What `worktree-gc` needs that the scheduler does not hand a routine (§1.1): the
 * projections, the forge (the only thing that can say a PR is closed), the sink its
 * facts go to, the box that reaches an owner and §9's worktree manager.
 * `apps/daemon` is the only place that has all five.
 */
export interface WorktreeGcDeps {
  /** The `Work`, `PullRequest` and `Worktree` projections (§3). */
  readonly read: ReadModel
  /**
   * Asked one question the log cannot answer: is this PR still open? A probe, not
   * an actor — this body never merges, retargets or deletes anything remote.
   */
  readonly pullRequests: PullRequests
  /** The facts are this run's outcome, so they go to the store without waking (§6). */
  readonly store: EventSink
  /** §7's only way to a peer. Absent records the facts and tells nobody. */
  readonly mailbox?: Mailbox
  /** §9's manager, and the only thing that removes a checkout. Absent leaves them all alone. */
  readonly worktrees?: Worktrees
  /**
   * Whether a holder's pid is a process that still exists. Injected because the
   * alternative is a test that spawns and kills real processes to prove §9's rule,
   * and because "alive" is the one thing in this body a fake can state exactly.
   */
  readonly isAlive?: HolderLiveness
}

/** §9 re-asks liveness at removal time; this is the seam a test answers instead. */
export type HolderLiveness = (pid: number) => boolean

/**
 * The real check: `kill(pid, 0)` signals nothing and asks the kernel whether the
 * process is there. `ESRCH` is the one answer that means gone — anything else
 * (a process owned by another user refusing our signal) is a process that exists,
 * and §9 never lets "maybe alive" read as dead.
 */
export const stillRunning: HolderLiveness = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (thrown) {
    return (thrown as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** The one spelling of a PR in a reason or a message: `owner/repo#12`. */
const at = (ref: PullRequestRef): string => `${String(ref.repo)}#${String(ref.number)}`

/** The `inputsHash` a run records: the observations that produced its facts (§5.4). */
const hashOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

/**
 * The `workId` the projection holds as a brand, or nothing — dropped rather than
 * thrown, for `branch-cleanup`'s reason: a checkout is still a fact worth handling
 * when the row that names its Work is malformed.
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
 * What the projection and the forge together say about one checkout's PR. `open`
 * and `none` are both "not yet": a PR still open is work in progress, and no PR at
 * all is a checkout nothing has said a word about — neither is a deletion.
 */
type Outcome = 'merged' | 'closed' | 'open' | 'none'

/**
 * One §7 message to the Work's assignee, delivered in the same run: a message that
 * waits for the next supervisor tick arrives after the checkout it was about was
 * already gone or already forgotten (`send_message` delivers too — §5.2, §7).
 *
 * `actions: 0` when there is nobody to tell: a checkout with no Work has no owner,
 * and an invented recipient is worse than silence.
 */
const tell = async (deps: WorktreeGcDeps, workId: WorkId | undefined, body: string): Promise<Tally> => {
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
  // It stays pending either way; the count is how a peer nobody can reach shows up
  // in `routine.finished` (§6, §7).
  return refused ? { actions: 1, failed: 1 } : { actions: 1, failed: 0 }
}

/** Why a checkout stays, as the message its owner gets — and as the observation a replay reads. */
interface Keep {
  readonly kind: 'keep'
  readonly why: string
}

/** Why a checkout goes. `merged` decides whether the Work it belonged to is finished too. */
interface Remove {
  readonly kind: 'remove'
  readonly why: string
  readonly merged: boolean
}

type Fate = Keep | Remove

/**
 * What one checkout's PR amounts to. Only a `finished` PR carries a `ref`, and the
 * `finished` flag is what a caller branches on: "still open" and "no PR at all" are
 * the cases this body has no opinion about, and a ref on them would be an invitation
 * to act on a PR nobody said was done.
 */
type Decided =
  | { readonly finished: true; readonly outcome: 'merged' | 'closed'; readonly ref: PullRequestRef }
  | { readonly finished: false; readonly outcome: 'open' | 'none' }

/**
 * §9's three terms, in the order that matters for the message an owner reads: a
 * checkout with local-only work is a person's afternoon whatever else is true
 * about it, and the sentence should be about that, not about a stale pid.
 *
 * The holder list is filtered through `isAlive` rather than trusted: §9 records a
 * scan, and a scan is a photograph. A pid that is `ESRCH` now is a leftover from a
 * process that exited — keeping the checkout for it would keep it for nothing.
 */
const fateOf = (
  row: Worktree,
  outcome: 'merged' | 'closed',
  ref: PullRequestRef,
  isAlive: HolderLiveness,
): Fate => {
  // §9, first and without exception: nothing is deleted with local-only work.
  if (row.dirty || row.unpushed) {
    const why = row.dirty ? 'has uncommitted changes' : 'has commits that were never pushed'
    return { kind: 'keep', why: `The worktree at ${row.path} ${why}; it was kept.` }
  }

  const live = row.holders.filter((holder) => isAlive(holder.pid))
  if (live.length > 0) {
    const who = live.map((holder) => holder.command ?? String(holder.pid)).join(', ')
    return { kind: 'keep', why: `The worktree at ${row.path} is in use (${who}); it was kept.` }
  }

  // The closed case names only the checkout: the branch is §10's, and its Work was
  // dropped rather than finished, so it is not `cleaned` either.
  const why =
    outcome === 'merged'
      ? `its PR ${at(ref)} merged, and the checkout was clean and pushed`
      : `its PR ${at(ref)} was closed without merging, and the checkout was clean and pushed`
  return { kind: 'remove', why, merged: outcome === 'merged' }
}

/**
 * Remove one checkout through §9's manager, and record it. The event is written
 * after the removal and only for a removal that happened: a log that claims a
 * checkout is gone while it is still on disk is worse than no log, because the row
 * the next sweep would have read is deleted by the event itself (§3's projector
 * drops the `Worktree` row on `worktree.removed`).
 *
 * A manager that refuses (git will not remove a checkout holding changes) is not a
 * removal that half-happened: it is reported to the owner and counted as a failure.
 */
const removeCheckout = async (
  deps: WorktreeGcDeps,
  ts: Timestamp,
  row: Worktree,
  fate: Remove,
  workId: WorkId | undefined,
): Promise<Tally> => {
  const manager = deps.worktrees
  // No manager is no removal. Recording one would be the lie described above, and
  // §9 makes the manager the only thing that may delete a checkout.
  if (manager === undefined) return none

  try {
    await manager.remove(row.path)
  } catch (thrown) {
    const why = thrown instanceof Error ? thrown.message : String(thrown)
    // A removal the run decided and git refused is a failed action, not a quiet
    // keep: the count in `routine.finished` is where a checkout that will not go
    // has to show up, or it shows up nowhere (§6).
    const told = await tell(deps, workId, `The worktree at ${row.path} could not be removed: ${why}`)
    return { actions: told.actions, failed: 1 }
  }

  const batch: AppendEvent[] = [
    {
      ts,
      type: 'worktree.removed',
      subject: String(row.worktreeId),
      actor: 'scheduler',
      data: { worktreeId: row.worktreeId, reason: fate.why },
    },
  ]
  // §9: the Work is finished when its checkout is gone — but only a Work that
  // merged is finished. A cancelled Work whose checkout we collect stays cancelled:
  // `work.cleaned` is a transition, and moving a person's "drop" to "cleaned" would
  // be this routine editing a decision it was not asked about.
  if (fate.merged && workId !== undefined) {
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

/** The open PRs of one repo, read at most once per run: the sweep asks per checkout. */
interface OpenList {
  (repo: Worktree['repo']): Promise<readonly PullRequest[]>
}

const openLists = (deps: WorktreeGcDeps): OpenList => {
  const seen = new Map<string, readonly PullRequest[]>()
  return async (repo) => {
    const key = String(repo)
    const known = seen.get(key)
    if (known !== undefined) return known
    const rows = await deps.pullRequests.list(repo, { state: 'open' })
    seen.set(key, rows)
    return rows
  }
}

/**
 * The PR a checkout belongs to, and what became of it. `rows` is the whole `PR`
 * projection, read once by the caller.
 *
 * "Closed" is the one fact no projection holds: §3 has no `pr.closed` event, which
 * `pr-babysit` says out loud in its own header. The only honest way to learn it is
 * to ask the forge which PRs are still open — a row the log holds that is not on
 * that list is one that closed, and `merged` on the row says which way.
 */
const outcomeOf = async (
  rows: readonly PullRequest[],
  row: Worktree,
  open: OpenList,
): Promise<Decided> => {
  const mine = rows.filter((pr) => pr.repo === row.repo && pr.head === row.branch)
  const merged = mine.find((pr) => pr.merged)
  if (merged !== undefined) {
    return { finished: true, outcome: 'merged', ref: { repo: merged.repo, number: merged.number } }
  }
  if (mine.length === 0) return { finished: false, outcome: 'none' }

  const listed = await open(row.repo)
  const stillOpen = mine.some((pr) => listed.some((entry) => entry.number === pr.number))
  if (stillOpen) return { finished: false, outcome: 'open' }

  // Closed without merging. Several rows on one branch is a branch that was pushed
  // twice; the first is the one whose Work the log names.
  const closed = mine[0] as PullRequest
  return { finished: true, outcome: 'closed', ref: { repo: closed.repo, number: closed.number } }
}

/** The `workId` a checkout's Work is known by: the PR's, which is what the merge recorded. */
const ownerOfWork = (
  rows: readonly PullRequest[],
  row: Worktree,
  outcome: 'merged' | 'closed',
): WorkId | undefined => {
  const mine = rows.filter((pr) => pr.repo === row.repo && pr.head === row.branch)
  const named = outcome === 'merged' ? mine.find((pr) => pr.merged) : mine[0]
  return workIdOf(named?.workId)
}

/**
 * The merge event's half: the one checkout this wake is about.
 *
 * The event names a PR and the projection says which branch that PR is, so the
 * checkout is `repo + head` — the same pair the manager created it with (§9). A
 * PR the projection does not hold as merged names no branch this body may act on,
 * and a merged PR with no checkout left is the ordinary case after `branch-cleanup`
 * got there first: `actions: 0`, not an error.
 */
const onMerge = async (
  deps: WorktreeGcDeps,
  context: RoutineContext,
): Promise<{ outcome: RoutineOutcome; observations: unknown }> => {
  const ts = context.clock.now()
  const empty = { event: context.event?.type } as const

  const data = context.event?.data as { pr?: PullRequestRef } | undefined
  const ref = data?.pr
  if (ref === undefined) return { outcome: { actions: 0, actionsFailed: 0, inputsHash: hashOf(empty) }, observations: empty }

  const pr = (await deps.read.pullRequests.all()).find(
    (row) => row.repo === ref.repo && row.number === ref.number,
  )
  if (pr === undefined || !pr.merged) {
    return {
      outcome: { actions: 0, actionsFailed: 0, inputsHash: hashOf({ ...empty, pr: at(ref), merged: pr?.merged }) },
      observations: { ...empty, pr: at(ref), merged: pr?.merged },
    }
  }

  const rows = (await deps.read.worktrees.all()).filter(
    (row) => row.repo === pr.repo && row.branch === pr.head,
  )
  const workId = workIdOf(pr.workId)
  const isAlive = deps.isAlive ?? stillRunning
  // Decided once per row: the fate is a reading of the row, and reading it twice is
  // how a run reports a different verdict from the one it acted on.
  const fates = rows.map((row) => ({ row, fate: fateOf(row, 'merged', ref, isAlive) }))
  const observations = fates.map(({ row, fate }) => ({ worktreeId: String(row.worktreeId), verdict: fate.kind }))

  let tally: Tally = none
  for (const { row, fate } of fates) {
    tally = plus(
      tally,
      fate.kind === 'keep' ? await tell(deps, workId, fate.why) : await removeCheckout(deps, ts, row, fate, workId),
    )
  }

  return {
    outcome: {
      actions: tally.actions,
      actionsFailed: tally.failed,
      inputsHash: hashOf({ ...empty, pr: at(ref), worktrees: observations }),
    },
    observations: { ...empty, pr: at(ref), worktrees: observations },
  }
}

/**
 * The nightly sweep's half: every checkout in the projection, and the conjunction
 * that may remove it.
 *
 * Ordered by `worktreeId` so two identical sweeps hash the same (§5.4): a replay
 * that diffs `inputsHash` must not see a difference the store did not make.
 */
const sweep = async (
  deps: WorktreeGcDeps,
  context: RoutineContext,
): Promise<{ outcome: RoutineOutcome; observations: unknown }> => {
  const ts = context.clock.now()
  const isAlive = deps.isAlive ?? stillRunning
  const rows = await deps.read.worktrees.all()
  const prs = await deps.read.pullRequests.all()
  const open = openLists(deps)

  const observations: { worktreeId: string; path: string; outcome: Outcome; verdict: string }[] = []
  let tally: Tally = none

  for (const row of [...rows].sort((left, right) => String(left.worktreeId).localeCompare(String(right.worktreeId)))) {
    const decided = await outcomeOf(prs, row, open)
    // Still open, or no PR at all: the observation says so and the sweep moves on.
    // A checkout nobody has said is done is the one case this body must not invent
    // a verdict for, and "not acted on" is a legitimate, visible outcome (§6).
    if (!decided.finished) {
      observations.push({ worktreeId: String(row.worktreeId), path: row.path, outcome: decided.outcome, verdict: 'none' })
      continue
    }

    const fate = fateOf(row, decided.outcome, decided.ref, isAlive)
    observations.push({ worktreeId: String(row.worktreeId), path: row.path, outcome: decided.outcome, verdict: fate.kind })
    const workId = ownerOfWork(prs, row, decided.outcome)
    tally = plus(
      tally,
      fate.kind === 'keep' ? await tell(deps, workId, fate.why) : await removeCheckout(deps, ts, row, fate, workId),
    )
  }

  return { outcome: { actions: tally.actions, actionsFailed: tally.failed, inputsHash: hashOf(observations) }, observations }
}

/**
 * One tick. An event wake collects the one checkout the merged PR names; a
 * scheduled wake sweeps. The `PM` and the executor are ignored on purpose — this
 * body decides no action the PM planned, like `pr-babysit`, `notify` and
 * `branch-cleanup` (§6).
 */
export const gc = async (deps: WorktreeGcDeps, context: RoutineContext): Promise<RoutineOutcome> => {
  const kind = context.event?.type
  const run = kind === 'work.merged' || kind === 'pr.merged' ? await onMerge(deps, context) : await sweep(deps, context)
  return run.outcome
}
