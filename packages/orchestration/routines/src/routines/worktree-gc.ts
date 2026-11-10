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
 * 3. **No holder, live or not.** §9 records the processes whose cwd is inside a
 *    checkout so `gc` can *report* them, never kill them. A live one is somebody
 *    working, so the checkout stays and the owner is told; a leftover pid is
 *    reported as a leftover, and the checkout still stays. `Worktree.holders` is the
 *    last scan's photograph and a process that started after it is not in the
 *    picture at all, so the row may only ever *keep* a checkout and never release
 *    one. Clearing the row belongs to whoever runs the scan; until it says the
 *    checkout is empty, this body has no business guessing that it is.
 *
 * **Every way of not knowing is the same answer.** The other two terms are facts
 * the projection holds, and the first one is not: §3 has no `pr.closed`, so
 * "closed" has to be asked of the forge. This body asks about the PR itself, one
 * PR at a time (`get`), and finishes a checkout only on an explicit `closed`.
 * A forge call that fails, a row with no state, a PR the forge says is not there —
 * all of them are *unknown*, and unknown keeps. The bug this replaced read the
 * forge's open *list*, which an adapter caps: a PR that is open past the page's
 * last row is absent from it, and absence read as "closed" deleted checkouts
 * nobody had finished with. A page is not a set, and no list can ever prove that
 * something is *not* on it.
 *
 * **Two ways in, one rule.** `work.merged`/`pr.merged` wakes the routine with the
 * one PR a merge is about — that names the branch, the branch names the checkout,
 * and only that checkout is considered. §6's daily 03:00 sweep considers every row
 * in the projection, which is how a checkout is collected while the daemon was
 * down for the merge, or after a PR was closed rather than merged.
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
  PullRequestState,
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
   * Whether a holder's pid is a process that still exists. It decides what the owner
   * is *told* — someone is in there, or the scan recorded a pid that has since
   * exited — and never what happens to the checkout: §9's rule is that a holder list
   * keeps, so a fake's answer to this cannot release anything.
   */
  readonly isAlive?: HolderLiveness
}

/**
 * What §9's holder report says about one pid. It is a sentence and not a gate: the
 * checkout is kept either way, so the only thing a fake's answer here can change is
 * what an owner reads.
 */
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
 * What the projection and the forge together say about one checkout's PR. `open`,
 * `none` and `unknown` are all "not yet": a PR still open is work in progress, no PR
 * at all is a checkout nothing has said a word about, and a question the forge did
 * not answer is a question still open. None of the three is a deletion.
 */
type Outcome = 'merged' | 'closed' | 'open' | 'none' | 'unknown'

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
  | { readonly finished: false; readonly outcome: 'open' | 'none' | 'unknown' }

/**
 * The forge's answer about one PR, or the fact that there was none. `state` is the
 * forge's own word and is never inferred: an answer that is not `closed` — including
 * a `merged` the log has not caught up with — keeps the checkout, and a merge
 * arrives as a `work.merged` wake of its own (§6).
 */
type Answer = { readonly heard: true; readonly state: PullRequestState } | { readonly heard: false }

/** Ask the forge about a PR: once per PR per run, and never twice. */
type Ask = (ref: PullRequestRef) => Promise<Answer>

/**
 * The forge, asked about one PR at a time.
 *
 * This is the whole fix for the fail-open deletion: a bounded list can only ever
 * prove that something *is* open, never that it is not, so the question "is this
 * one done?" is asked of the PR rather than of a page of PRs. `get` is the port's
 * answer to exactly this — `undefined` for "no such PR", a throw for "the call
 * failed" — and both are `heard: false` here, because neither is `closed`.
 *
 * Memoized per run: the event path asks about one PR twice at most (a branch pushed
 * twice names two), and the sweep asks once per checkout, which for two checkouts on
 * one branch is one `gh` call rather than two.
 */
const askers = (deps: WorktreeGcDeps): Ask => {
  const heard = new Map<string, Answer>()
  return async (ref) => {
    const key = at(ref)
    const known = heard.get(key)
    if (known !== undefined) return known

    let answer: Answer
    try {
      const row = await deps.pullRequests.get(ref.repo, ref.number)
      answer = row?.state === undefined ? { heard: false } : { heard: true, state: row.state }
    } catch {
      // Not rethrown, and not silence either: a whole sweep must not be lost to one
      // PR the forge would not talk about, and the run counts the checkouts it could
      // not decide (§6) rather than reporting a clean sweep of none.
      answer = { heard: false }
    }
    heard.set(key, answer)
    return answer
  }
}

/**
 * §9's three terms, in the order that matters for the message an owner reads: a
 * checkout with local-only work is a person's afternoon whatever else is true
 * about it, and the sentence should be about that, not about a stale pid.
 *
 * The holder list may only ever keep (§9): it is the last scan's photograph, so it
 * cannot see a process that started after it, and a removal decided on a photograph
 * is the failure the rule exists to prevent. A pid that is `ESRCH` now is a leftover
 * rather than a reason to keep — but it is still a reason not to *delete*: the scan
 * that clears the row is the thing that makes the checkout empty, and this body is
 * not that.
 */
const fateOf = (row: Worktree, outcome: 'merged' | 'closed', ref: PullRequestRef, isAlive: HolderLiveness): Fate => {
  // §9, first and without exception: nothing is deleted with local-only work.
  if (row.dirty || row.unpushed) {
    const why = row.dirty ? 'has uncommitted changes' : 'has commits that were never pushed'
    return { kind: 'keep', why: `The worktree at ${row.path} ${why}; it was kept.` }
  }

  if (row.holders.length > 0) {
    const live = row.holders.filter((holder) => isAlive(holder.pid))
    const who = (live.length > 0 ? live : row.holders)
      .map((holder) => holder.command ?? String(holder.pid))
      .join(', ')
    const why =
      live.length === 0
        ? `The worktree at ${row.path} was last seen in use (${who}) and no scan has cleared it since; it was kept.`
        : `The worktree at ${row.path} is in use (${who}); it was kept.`
    return { kind: 'keep', why }
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
  // §9: the Work is finished when its checkout is gone — but only a Work that merged
  // is finished. `work.cleaned` is a transition, not a notification, so it is written
  // only when the row it moves is actually at `merged`: a cancelled Work keeps the
  // person's "drop", a Work already cleaned needs nothing, and a Work the log does not
  // hold has no row to move. The projector refuses the same transition for the same
  // reason — a log is not the only writer, and the guard that matters is the one that
  // holds for every producer.
  if (fate.merged && workId !== undefined) {
    const work = await deps.read.work.get(workId)
    if (work?.state === 'merged') {
      batch.push({
        ts,
        type: 'work.cleaned',
        subject: workId,
        actor: 'scheduler',
        data: { workId, worktreeId: row.worktreeId },
      })
    }
  }
  await deps.store.append(batch)
  return { actions: 1, failed: 0 }
}

/**
 * §9's last step for a Work whose checkout is **already gone**: nothing to remove, and
 * the transition still owed.
 *
 * This is not an edge case but the ordinary `work.merged` wake. `branch-cleanup` runs on
 * the same `pr.merged` that made the merge, *before* `work-sync` has turned that PR into
 * this `work.merged` (a committed listener runs after the scheduler's wake), so it cannot
 * write `cleaned` there — the Work is still `mergeable`. By the time this event arrives
 * the checkout has gone with the branch, and this is the run that owes the Work its last
 * step. The gate is the same one `removeCheckout` uses: only a `merged` Work has a path to
 * `cleaned`, so a Work this body did not see finish is left alone rather than invented.
 */
const finishWork = async (deps: WorktreeGcDeps, ts: Timestamp, workId: WorkId | undefined): Promise<Tally> => {
  if (workId === undefined) return none
  const work = await deps.read.work.get(workId)
  if (work?.state !== 'merged') return none

  await deps.store.append([
    { ts, type: 'work.cleaned', subject: workId, actor: 'scheduler', data: { workId } },
  ])
  return { actions: 1, failed: 0 }
}

/**
 * The PR a checkout belongs to, and what became of it. `rows` is the whole `PR`
 * projection, read once by the caller; `ask` is the forge, for the one fact no
 * projection holds (§3 has no `pr.closed`).
 *
 * A merge is answered by the log alone — a `pr.merged` event is not a thing that
 * un-happens — and everything else is answered by the forge. A branch pushed twice
 * has several rows and the checkout goes only when **every** one of them is
 * explicitly closed: one open PR on the branch is one reason to stay, whatever the
 * other rows say.
 */
const outcomeOf = async (rows: readonly PullRequest[], row: Worktree, ask: Ask): Promise<Decided> => {
  const mine = rows.filter((pr) => pr.repo === row.repo && pr.head === row.branch)
  const merged = mine.find((pr) => pr.merged)
  if (merged !== undefined) {
    return { finished: true, outcome: 'merged', ref: { repo: merged.repo, number: merged.number } }
  }
  if (mine.length === 0) return { finished: false, outcome: 'none' }

  const answers = await Promise.all(mine.map((pr) => ask({ repo: pr.repo, number: pr.number })))
  // One PR the forge did not answer leaves the verdict unknown, and unknown keeps: it
  // may be the closed one, and a run that cannot tell must not act as though it can.
  if (answers.some((answer) => !answer.heard)) return { finished: false, outcome: 'unknown' }
  // Anything the forge does not call `closed` keeps the checkout, including a `merged`
  // the log has not recorded yet: that merge has a wake of its own, and it will arrive
  // with the `work.merged` this body needs to move the Work too.
  if (answers.some((answer) => answer.heard && answer.state !== 'closed')) return { finished: false, outcome: 'open' }

  // Closed without merging, and every row on the branch agrees. The first is the one
  // whose Work the log names.
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
 * got there first: not an error, and the run that still owes the Work its `cleaned`
 * (`finishWork`).
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

  // No checkout left is the ordinary case after `branch-cleanup` got there first, and it
  // is still the run that owes the Work its last step: a Work that merged with its
  // checkout already gone would otherwise sit at `merged` with nobody left to move it.
  let tally: Tally = rows.length === 0 ? await finishWork(deps, ts, workId) : none
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
  const ask = askers(deps)

  const observations: { worktreeId: string; path: string; outcome: Outcome; verdict: string }[] = []
  let tally: Tally = none

  for (const row of [...rows].sort((left, right) => String(left.worktreeId).localeCompare(String(right.worktreeId)))) {
    const decided = await outcomeOf(prs, row, ask)
    // Still open, no PR at all, or a question the forge did not answer: the
    // observation says which, and the sweep moves on. A checkout nobody has said is
    // done is the one case this body must not invent a verdict for, and "not acted
    // on" is a legitimate, visible outcome (§6).
    if (!decided.finished) {
      observations.push({ worktreeId: String(row.worktreeId), path: row.path, outcome: decided.outcome, verdict: 'none' })
      // The one that is *not* a quiet keep: this checkout was this tick's to decide and
      // the run could not, which is a failure to report (§6) rather than a sweep that
      // found nothing. Counted the way `tracker-sync` counts one card it could not
      // read: no action taken, one action failed.
      if (decided.outcome === 'unknown') tally = plus(tally, { actions: 0, failed: 1 })
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
