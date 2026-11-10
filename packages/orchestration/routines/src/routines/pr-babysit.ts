/**
 * `pr-babysit` (§6): the fleet's eyes on its own pull requests.
 *
 * §6's row names three duties — keep the `PR` projection current, retarget stacked
 * dependents, nudge on a red or conflicting PR. Only the first and the third are
 * this routine's. Retargeting is §10's rule in the PM (`retargetDependents`) carried
 * out by the gate's `retarget` action, and a second place that moved a base would be
 * a second answer to "what is this PR sitting on". What is left is the half no PM
 * tick can do, because it needs a fact the log does not have yet: asking the forge.
 *
 * So one run polls each repo the profile names and writes what it *observed* as the
 * events §10's row is projected from:
 *
 * - `pr.opened` when the fleet has never seen the PR, **or when its head moved** —
 *   the event's own doc says both, and the head sha the projection then holds is the
 *   one `mergeGreenPrs` pins its merge to (§10).
 * - `pr.checks_changed` and `pr.review_changed` when they differ from the row, so a
 *   write means a change and not a heartbeat: a poll that finds nothing appends
 *   nothing, which is what keeps `actions: 0` worth reading (§6).
 * - `pr.merged` for a row that left the open list and reads back merged. Without it
 *   a PR merged by hand — or by the gate while this routine was down — leaves a row
 *   nobody will ever correct, and §9's `worktree-gc` waits on that row.
 *
 * **Checks are recorded only at a head the log already knows** (§10). One poll is one
 * read — head, checks and review come from the same row — so the sha that was graded
 * is the sha that is reported. If that sha is not the one in the projection, this tick
 * records the head move and stops there: checks attached to a commit the log cannot
 * identify are the §10 bug the pin exists to prevent, one step earlier. The next poll
 * records them against the row this one wrote.
 *
 * **A nudge is per red head, not per poll.** The message goes out on the transition
 * into failing, because a routine that says the same thing every five minutes is one
 * a peer learns to ignore. The peer is the Work's assignee: the fleet's author of a
 * PR is whoever was assigned its Work, and `pr.workId` is the footer
 * `integrations/github` read off the body. A PR with no Work has no author to nudge.
 *
 * The body appends through its own sink rather than the waking one, for `notify`'s
 * reason: these events are the outcome of a wake, and waking `pr-babysit` on its own
 * `pr.checks_changed` would run it again to find the same nothing. `dispatch`'s
 * heartbeat is what turns the new rows into a merge request, and that is the point —
 * this routine records facts and decides nothing (§5.2).
 *
 * TODO(§10): §6 also says "rebases/nudges on conflict", and a conflict is not
 * observable through `PullRequests` today — `PullRequest` carries no mergeability and
 * the forge's `mergeStateStatus` is not in the port. It is left out rather than
 * guessed at; detecting it is a contract change first.
 */

import { createHash } from 'node:crypto'
import { safeParse, workId as workIdShape, type Repo, type Seq, type Timestamp } from '@fleet/foundation-core'
import type {
  AppendEvent,
  EventSink,
  Mailbox,
  PullRequest,
  PullRequestRef,
  PullRequests,
  ReadModel,
  WorkId,
} from '@fleet/foundation-contracts'
import type { RoutineContext, RoutineOutcome } from '../routine.ts'

/**
 * What `pr-babysit` needs that the scheduler does not hand a routine (§1.1): the
 * forge's port, the sink its facts go to and the Mailbox a nudge travels through.
 * `apps/daemon` is the only place that has all three, so it builds the factory.
 */
export interface PrBabysitDeps {
  /** The `PR` and `Work` projections, and the peers a nudge is written from (§3). */
  readonly read: ReadModel
  /** §10's port: where an observation comes from. */
  readonly pullRequests: PullRequests
  /** The facts are this run's outcome, so they go to the store without waking (§6). */
  readonly store: EventSink
  /** §7's only way to a peer. Absent records the facts and nudges nobody. */
  readonly mailbox?: Mailbox
  /** The repos this fleet has PRs in — the profile's `repos` (§2). */
  readonly repos: readonly Repo[]
}

/** A PR as every event names it: the repo and the number. */
const refOf = (pr: PullRequest): PullRequestRef => ({ repo: pr.repo, number: pr.number })

/** The one spelling of a PR in a subject or a message: `owner/repo#12`. */
const at = (ref: PullRequestRef): string => `${String(ref.repo)}#${String(ref.number)}`

/**
 * §10's pin as an equality: the observation describes the row only if it is the
 * row's head. Stated here rather than imported because `orchestration` may not
 * import `integrations` (§1.1) — it is the same predicate `matchHeadSha` is.
 */
const describes = (observed: PullRequest, recorded: PullRequest): boolean =>
  observed.headSha === recorded.headSha

/** Checks are the same check set when the names match, whatever order `gh` listed them in. */
const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name) => right.includes(name))

/** The `inputsHash` a run records: the observations that produced its facts (§5.4). */
const hashOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

/**
 * The `workId` footer as the contract spells it. A footer `gh` reported but the
 * contract would refuse is not one — dropped rather than thrown at append, because
 * the PR is still a fact worth recording.
 */
const workIdOf = (value: string | undefined): WorkId | undefined => {
  if (value === undefined) return undefined
  const parsed = safeParse(workIdShape(), value)
  return parsed.ok ? parsed.value : undefined
}

const openedEvent = (ts: Timestamp, pr: PullRequest): AppendEvent => {
  const workId = workIdOf(pr.workId)
  return {
    ts,
    type: 'pr.opened',
    subject: at(refOf(pr)),
    actor: 'scheduler',
    data: {
      pr: refOf(pr),
      base: pr.base,
      head: pr.head,
      headSha: pr.headSha,
      ...(workId === undefined ? {} : { workId }),
      ...(pr.stackParent === undefined ? {} : { stackParent: pr.stackParent }),
    },
  }
}

const checksEvent = (ts: Timestamp, pr: PullRequest): AppendEvent => ({
  ts,
  type: 'pr.checks_changed',
  subject: at(refOf(pr)),
  actor: 'scheduler',
  data: { pr: refOf(pr), headSha: pr.headSha, state: pr.checks, failing: pr.failingChecks },
})

/**
 * A review, as far as the port can tell it. `reviewer` is a `peerId` and the forge
 * reports a login, which is a different name for a different thing — left out
 * rather than mistranslated (§7).
 */
const reviewEvent = (ts: Timestamp, pr: PullRequest): AppendEvent => ({
  ts,
  type: 'pr.review_changed',
  subject: at(refOf(pr)),
  actor: 'scheduler',
  data: { pr: refOf(pr), headSha: pr.headSha, state: pr.review },
})

/**
 * A row that left the open list and reads back merged. The gate writes the same
 * event when it merges, so this fires only for a merge the fleet did not perform —
 * by hand, or while this routine was down — and the projection dedupes either way.
 */
const mergedEvent = (ts: Timestamp, pr: PullRequest): AppendEvent => ({
  ts,
  type: 'pr.merged',
  subject: at(refOf(pr)),
  actor: 'scheduler',
  data: { pr: refOf(pr), headSha: pr.headSha },
})

/** A nudge the run decided on, and the checks event that caused it (§3's `causedBy`). */
interface Nudge {
  readonly pr: PullRequest
  readonly event: number
}

interface Tally {
  readonly actions: number
  readonly failed: number
}

/**
 * One §7 message to the PR's author, delivered in the same run: a nudge that waits
 * for the next supervisor tick arrives after the thing it was about — the reason
 * `send_message` delivers too (§5.2, §7).
 *
 * `actions: 0` when there is nobody to tell, because a PR with no Work has no author
 * and an invented recipient is worse than silence. A message the Mailbox cannot take
 * (a peer with no brief to cite) is a failure the run reports: the fleet wanted to
 * say something and did not.
 */
const nudge = async (
  deps: PrBabysitDeps,
  pr: PullRequest,
  causedBy: Seq | undefined,
): Promise<Tally> => {
  const nothing: Tally = { actions: 0, failed: 0 }
  const mailbox = deps.mailbox
  const workId = workIdOf(pr.workId)
  if (mailbox === undefined || workId === undefined) return nothing

  const work = await deps.read.work.get(workId)
  const to = work?.assignee
  if (to === undefined) return nothing

  const briefVersion = (await deps.read.peers.get(to))?.briefVersion
  if (briefVersion === undefined) return { actions: 1, failed: 1 }

  const sent = await mailbox.send({
    to,
    // A routine speaks for the fleet, not for the PM: nothing decided this message (§5.2).
    from: 'scheduler',
    kind: 'nudge',
    briefVersion,
    body: nudgeBody(pr),
    ...(causedBy === undefined ? {} : { causedBy: [causedBy] }),
  })
  if (!sent.ok) return { actions: 1, failed: 1 }

  const delivered = await mailbox.deliver(to)
  if (!delivered.ok) return { actions: 1, failed: 1 }
  const refused = delivered.value.failures.some((failure) => failure.msgId === sent.value)
  // It stays pending in the box either way; the count is how a peer nobody can
  // reach shows up in `routine.finished` (§6, §7).
  return refused ? { actions: 1, failed: 1 } : { actions: 1, failed: 0 }
}

/**
 * What a peer is told: which checks, on which commit, and the one rule that makes
 * the difference — the gate merges the head that went green, so a fix has to go
 * green on the new head too (§10).
 */
const nudgeBody = (pr: PullRequest): string => {
  const what = pr.failingChecks.length === 0 ? 'CI is red' : `CI is red (${pr.failingChecks.join(', ')})`
  const head = String(pr.headSha).slice(0, 10)
  return `${what} on ${at(refOf(pr))} at ${head}. Push a fix, and it has to go green on the new head: the gate merges the sha it saw pass.`
}

/**
 * One tick: poll, record what changed, close out rows that left the open list,
 * nudge the author of a PR that just went red.
 *
 * The `PM` and the executor the scheduler offers are ignored on purpose — this body
 * decides no action and performs none the PM planned; `notify` is the other one, and
 * for the same reason (§6).
 */
export const babysit = async (deps: PrBabysitDeps, context: RoutineContext): Promise<RoutineOutcome> => {
  const ts = context.clock.now()
  const known = new Map((await deps.read.pullRequests.all()).map((row) => [at(refOf(row)), row]))
  const batch: AppendEvent[] = []
  const nudges: Nudge[] = []
  const observations: unknown[] = []
  const seen = new Set<string>()

  for (const repo of deps.repos) {
    const open = await deps.pullRequests.list(repo, { state: 'open' })
    for (const pr of open) {
      seen.add(at(refOf(pr)))
      // Already merged: the gate writes that row, and a second writer would disagree
      // with it about what a merge is (§10).
      if (pr.merged) continue

      const key = at(refOf(pr))
      const recorded = known.get(key)
      observations.push({
        pr: key,
        headSha: pr.headSha,
        base: pr.base,
        head: pr.head,
        checks: pr.checks,
        failing: pr.failingChecks,
        review: pr.review,
      })

      if (recorded === undefined || !describes(pr, recorded)) {
        batch.push(openedEvent(ts, pr))
        continue
      }

      const checksMoved = recorded.checks !== pr.checks || !sameNames(recorded.failingChecks, pr.failingChecks)
      if (checksMoved) {
        const index = batch.length
        batch.push(checksEvent(ts, pr))
        // Only a transition into red is news; a PR that stays red is one the author
        // has already been told about.
        if (pr.checks === 'failing' && recorded.checks !== 'failing') nudges.push({ pr, event: index })
      }

      if (recorded.review !== pr.review) batch.push(reviewEvent(ts, pr))
    }
  }

  // A row the log holds as open but the forge no longer lists was closed or merged.
  // Only a merge is an event — §3 has no `pr.closed`, and a merge is the fact `Work`
  // and §9's `worktree-gc` act on. The re-read is what tells the two apart.
  const watched = new Set(deps.repos.map(String))
  for (const [key, row] of known) {
    if (row.merged || seen.has(key) || !watched.has(String(row.repo))) continue
    const again = await deps.pullRequests.get(row.repo, row.number)
    observations.push({ pr: key, leftOpen: true, merged: again?.merged ?? false })
    if (again !== undefined && again.merged) batch.push(mergedEvent(ts, again))
  }

  // A store that refuses the batch throws: a run that recorded nothing must not then
  // nudge about it, and `routine.failed` is where that belongs, not an `actions: 0`.
  const seqs = batch.length === 0 ? [] : await deps.store.append(batch)

  let actions = batch.length
  let failed = 0
  for (const pending of nudges) {
    const told = await nudge(deps, pending.pr, seqs[pending.event])
    actions += told.actions
    failed += told.failed
  }

  return { actions, actionsFailed: failed, inputsHash: hashOf(observations) }
}
