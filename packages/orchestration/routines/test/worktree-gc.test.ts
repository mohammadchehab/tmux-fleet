/**
 * `worktree-gc` (§6, §9). §9's rule is a conjunction — the PR is done, the
 * checkout is clean and pushed, nothing is sitting in it — and the tests are about
 * each term, because each one is a different person's work:
 *
 * - the first is the fleet's own bookkeeping (a merge, or a Work that was dropped
 *   and whose PR closed unmerged), and it is the term the forge has to answer: §3
 *   has no `pr.closed`, so "is this PR still open?" is a question only `get` can
 *   answer, one PR at a time. The suite pins that down from the side that matters —
 *   a page of open PRs is *not* an answer, and a checkout whose PR is open past the
 *   page's last row stays;
 * - the second is somebody's afternoon (dirty, or commits never pushed);
 * - the third is somebody's process, which §9 says `gc` reports and never kills.
 *   A holder row is the last scan's photograph, so it may only ever keep: a pid that
 *   has since exited is reported as a leftover and the checkout still stays.
 *
 * The closed case gets its own weight here because it is the one this body owns
 * outright: `branch-cleanup` deletes a merged branch and the checkout that went
 * with it, and nothing in §10 gives a closed branch a deletion at all. So the
 * checkout goes and the branch is left exactly where it is — every write on the
 * fake forge throws, so a test cannot pass by a `gc` run that deleted a branch on
 * its way past a checkout.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ok,
  parse,
  peerId,
  repo,
  sha,
  workId,
  worktreeId,
  type PeerId,
  type Repo,
  type Result,
  type Sha,
  type WorkId,
} from '@fleet/foundation-core'
import {
  appendIssues,
  eventSchemaFor,
  peer as peerSchema,
  pullRequest as pullRequestSchema,
  work as workSchema,
  worktree as worktreeSchema,
  type AppendEvent,
  type FleetEvent,
  type Mailbox,
  type OutboundMessage,
  type Peer,
  type PullRequest,
  type PullRequestState,
  type PullRequests,
  type Work,
  type Worktree,
  type Worktrees,
} from '@fleet/foundation-contracts'
import type { RoutineContext, RoutineOutcome } from '../src/routine.ts'
import { gc, type HolderLiveness } from '../src/routines/worktree-gc.ts'
import { AT, fakeRead, fakeStore, movableClock, type FakeStore } from './support/fakes.ts'

const REPO: Repo = parse(repo(), 'acme/widgets')
const HEAD: Sha = parse(sha(), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
const ENGINEER: PeerId = parse(peerId(), 'engineer-1')
const WORK: WorkId = parse(workId(), 'wrk_0123456789abcdef')
const BRANCH = 'fleet/work-1'
const PATH = `/repo/.claude/worktrees/${BRANCH}`
const OTHER_WORKTREE = parse(worktreeId(), 'wtr_fedcba9876543210')

const eventContext = (event: FleetEvent): RoutineContext => ({
  routineId: 'worktree-gc',
  kind: 'worktree-gc',
  trigger: 'event',
  at: AT,
  clock: movableClock(),
  event,
})

const scheduleContext = (): RoutineContext => ({
  routineId: 'worktree-gc',
  kind: 'worktree-gc',
  trigger: 'schedule',
  at: AT,
  clock: movableClock(),
})

/** `work.merged`, built through the registry's own schema (§3). */
const workMerged = (seq = 7): FleetEvent =>
  parse(eventSchemaFor('work.merged')!, {
    seq,
    ts: AT,
    type: 'work.merged',
    subject: String(WORK),
    actor: 'scheduler',
    data: { workId: WORK, pr: { repo: REPO, number: 12 }, headSha: HEAD },
  }) as FleetEvent

/** The PR as the projection holds it (§3). `merged: false` is "the log has seen it". */
const prRow = (fields: Partial<PullRequest> = {}): PullRequest =>
  parse(pullRequestSchema(), {
    repo: REPO,
    number: 12,
    base: 'main',
    head: BRANCH,
    headSha: HEAD,
    checks: 'passing',
    failingChecks: [],
    review: 'approved',
    workId: String(WORK),
    merged: true,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  })

const workRow = (fields: Partial<Work> = {}): Work =>
  parse(workSchema(), {
    workId: WORK,
    title: 'wire the mailer',
    state: 'merged',
    assignee: ENGINEER,
    dependsOn: [],
    prs: [{ repo: REPO, number: 12 }],
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  })

const peerRow = (): Peer =>
  parse(peerSchema(), {
    peerId: ENGINEER,
    role: 'engineer',
    providerId: 'claude',
    model: 'sonnet',
    permissionMode: 'default',
    briefVersion: 3,
    state: 'idle',
    registeredAt: AT,
    updatedAt: AT,
  })

const worktreeRow = (fields: Partial<Worktree> = {}): Worktree =>
  parse(worktreeSchema(), {
    worktreeId: 'wtr_0123456789abcdef',
    repo: REPO,
    branch: BRANCH,
    path: PATH,
    ownerPeerId: ENGINEER,
    class: 'merged',
    dirty: false,
    unpushed: false,
    holders: [],
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  })

/**
 * §9's forge, as far as this body may use it: `get`, one PR at a time, answering the
 * forge's own `state`.
 *
 * `list` is recorded and *not* forbidden, so a test can show the trap: `page` is the
 * bounded page a list read would get, and the suite asserts `lists` is empty — the
 * body never decides anything from a set it cannot see all of. Every write throws,
 * so no test can pass by a `gc` run that deleted a branch on its way past a checkout.
 */
interface FakeForge extends PullRequests {
  /** The PR numbers asked about, in the order asked. */
  readonly asked: readonly number[]
  /** Every list state read — expected to stay empty (§9). */
  readonly lists: readonly (string | undefined)[]
}

const fakeForge = (
  options: {
    /** The PRs the forge has, as `get` returns them. */
    readonly rows?: readonly PullRequest[]
    /** The forge's own `state` per PR number. A number missing here has no state at all. */
    readonly states?: Readonly<Record<number, PullRequestState>>
    /** PR numbers the forge refuses to answer — a `gh` that failed, not a PR that is gone. */
    readonly fail?: readonly number[]
    /** What a bounded `list` would return: a page, and never the whole set. */
    readonly page?: readonly PullRequest[]
  } = {},
): FakeForge => {
  const asked: number[] = []
  const lists: (string | undefined)[] = []
  const refused = new Set(options.fail ?? [])
  const write = (name: string) => async () => {
    throw new Error(`worktree-gc must not call ${name}: it removes checkouts, not refs (§9, §10)`)
  }
  return {
    asked,
    lists,
    list: async (_named, listOptions) => {
      lists.push(listOptions?.state)
      return options.page ?? []
    },
    get: async (_named, number) => {
      asked.push(number)
      if (refused.has(number)) throw new Error(`gh pr view ${String(number)} exited 1: API rate limit exceeded`)
      const row = (options.rows ?? []).find((pr) => pr.number === number)
      if (row === undefined) return undefined
      const state = options.states?.[number]
      return state === undefined ? row : { ...row, state }
    },
    searchIntent: write('searchIntent'),
    create: write('create'),
    checks: write('checks'),
    review: write('review'),
    retarget: write('retarget'),
    dependents: write('dependents'),
    merge: write('merge'),
    branches: write('branches'),
    defaultBranch: write('defaultBranch'),
    deleteBranch: write('deleteBranch'),
  }
}

/** The forge that has the log's own rows, and calls the one this test is about `state`. */
const forgeSaying = (state: PullRequestState, rows: readonly PullRequest[] = [prRow()]): FakeForge =>
  fakeForge({ rows, states: Object.fromEntries(rows.map((row) => [row.number, state])) })

/** §7's box, recording what it was handed. */
interface FakeMailbox extends Mailbox {
  readonly sent: readonly OutboundMessage[]
}

const fakeMailbox = (): FakeMailbox => {
  const sent: OutboundMessage[] = []
  return {
    sent,
    send: async (message) => {
      sent.push(message)
      return ok(`msg_${String(sent.length).padStart(16, '0')}`) as Result<never, never>
    },
    deliver: async (to) =>
      ok({ peerId: to, delivered: [], resumed: false, failures: [] }) as Result<never, never>,
    pending: async () => [],
    ack: async () => ok(undefined),
    reject: async () => ok(undefined),
    history: async () => [],
  }
}

/** §9's manager, recording what it was asked to remove. */
interface FakeWorktrees extends Worktrees {
  readonly removed: readonly string[]
  refuse: boolean
}

const fakeWorktrees = (): FakeWorktrees => {
  const removed: string[] = []
  const manager: FakeWorktrees = {
    removed,
    refuse: false,
    remove: async (path) => {
      if (manager.refuse) throw new Error(`git refused to remove the worktree at ${path}`)
      removed.push(path)
    },
  }
  return manager
}

interface Harness {
  readonly forge: FakeForge
  readonly mailbox: FakeMailbox
  readonly worktrees: FakeWorktrees
  readonly store: FakeStore
  readonly run: (context: RoutineContext) => Promise<RoutineOutcome>
}

const harness = (
  forge: FakeForge,
  options: {
    readonly projection?: readonly PullRequest[]
    readonly work?: readonly Work[]
    readonly worktrees?: readonly Worktree[]
    readonly manager?: FakeWorktrees
    /** Which pids are still processes. Defaults to none: every recorded holder is a leftover. */
    readonly alive?: readonly number[]
    /** Drop the optional ports, to prove the body still records and does not throw. */
    readonly without?: readonly ('mailbox' | 'worktrees')[]
  } = {},
): Harness => {
  const mailbox = fakeMailbox()
  const worktrees = options.manager ?? fakeWorktrees()
  const store = fakeStore()
  const rows = fakeRead({
    ...(options.projection === undefined ? {} : { pullRequests: options.projection }),
    work: options.work ?? [workRow()],
    peers: [peerRow()],
    ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
  })
  const alive = new Set(options.alive ?? [])
  const isAlive: HolderLiveness = (pid) => alive.has(pid)
  const drop = new Set(options.without ?? [])

  const run = async (context: RoutineContext) => {
    const outcome = await gc(
      {
        read: rows,
        pullRequests: forge,
        store,
        ...(drop.has('mailbox') ? {} : { mailbox }),
        ...(drop.has('worktrees') ? {} : { worktrees }),
        isAlive,
      },
      context,
    )
    // Every fact is an event, and every event one the store would accept (§3).
    for (const event of store.appended) {
      assert.deepEqual(appendIssues(event), [], `the store would refuse ${event.type}`)
    }
    return outcome
  }
  return { forge, mailbox, worktrees, store, run }
}

const typesOf = (store: FakeStore): readonly string[] =>
  store.appended.map((event: AppendEvent): string => event.type)

describe('a checkout whose Work is done (§9)', () => {
  it('removes the checkout of a merged Work and records both facts', async () => {
    const seen = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow()] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [PATH])
    assert.deepEqual(typesOf(seen.store), ['worktree.removed', 'work.cleaned'])
    assert.equal((seen.store.appended[0]?.data as { reason: string }).reason, 'its PR acme/widgets#12 merged, and the checkout was clean and pushed')
    assert.equal(outcome.actions, 1)
    assert.equal(outcome.actionsFailed, 0)
    assert.deepEqual(seen.forge.asked, [], 'a merge is the log’s fact; the forge is not asked about it')
  })

  it('removes nothing and says nothing for a PR that is still open', async () => {
    const open = prRow({ merged: false })
    const seen = harness(forgeSaying('open', [open]), { projection: [open], worktrees: [worktreeRow()] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.deepEqual(typesOf(seen.store), [])
    assert.equal(outcome.actions, 0)
  })

  it('says nothing about a checkout the log has no PR for', async () => {
    const seen = harness(fakeForge(), { projection: [], worktrees: [worktreeRow()] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.equal(seen.mailbox.sent.length, 0)
    assert.equal(outcome.actions, 0)
    assert.deepEqual(seen.forge.asked, [], 'no PR to ask about')
  })
})

describe('a PR closed without merging (§9, §10)', () => {
  it('removes the checkout and leaves the branch alone', async () => {
    // The forge says `closed` about this PR. §10 gives that branch no deletion, so
    // only the checkout goes.
    const closed = prRow({ merged: false })
    const seen = harness(forgeSaying('closed', [closed]), { projection: [closed], worktrees: [worktreeRow()] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [PATH], 'the checkout is collected')
    assert.deepEqual(typesOf(seen.store), ['worktree.removed'], 'no `work.cleaned`: the Work was dropped, not finished')
    assert.match(String((seen.store.appended[0]?.data as { reason: string }).reason), /closed without merging/)
    assert.equal(outcome.actionsFailed, 0)
  })

  it('keeps the checkout when the branch has a second PR that is still open', async () => {
    // The branch was pushed twice: one PR closed, one still open. The checkout is
    // still somebody's, and the open one is enough to say so.
    const open = parse(pullRequestSchema(), { ...prRow({ merged: false }), number: 13 })
    const closed = prRow({ merged: false })
    const forge = fakeForge({ rows: [closed, open], states: { 12: 'closed', 13: 'open' } })
    const seen = harness(forge, { projection: [closed, open], worktrees: [worktreeRow()] })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.deepEqual(seen.forge.asked, [12, 13], 'every PR on the branch is asked about')
  })
})

describe('a forge answer is the only thing that closes a PR (§9)', () => {
  it('keeps a checkout whose open PR is not on the page of open PRs', async () => {
    // The bug this suite exists for: `list` is capped, so a PR that is open past the
    // last row is *absent* from the page. Absence read as "closed" deleted a checkout
    // somebody was still working under. The forge is asked about the PR itself.
    const open = prRow({ merged: false })
    const shortPage: readonly PullRequest[] = []
    const forge = fakeForge({ rows: [open], states: { 12: 'open' }, page: shortPage })
    const seen = harness(forge, { projection: [open], worktrees: [worktreeRow()] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [], 'an open PR past the page is still an open PR')
    assert.deepEqual(seen.forge.lists, [], 'a bounded page is never the answer to “is this one done?”')
    assert.deepEqual(seen.forge.asked, [12])
    assert.equal(outcome.actionsFailed, 0)
  })

  it('keeps the checkout when the forge lookup fails, and counts what it could not decide', async () => {
    // `gh` was rate-limited. A failed read is not a closed PR, and a sweep that
    // cannot decide a checkout must not report a clean sweep of none (§6).
    const open = prRow({ merged: false })
    const seen = harness(fakeForge({ rows: [open], fail: [12] }), { projection: [open], worktrees: [worktreeRow()] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [], 'a question with no answer never removes anything')
    assert.deepEqual(typesOf(seen.store), [])
    assert.equal(outcome.actions, 0, 'nothing was acted on')
    assert.equal(outcome.actionsFailed, 1, 'the checkout this tick could not decide')
  })

  it('keeps the checkout when the forge names no state at all', async () => {
    // A `gh` that answers without a state, or an adapter that was not told one. The
    // absence of an answer is unknown, and unknown is never `closed`.
    const open = prRow({ merged: false })
    const seen = harness(fakeForge({ rows: [open] }), { projection: [open], worktrees: [worktreeRow()] })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
  })

  it('keeps the checkout when the forge says the PR is not there', async () => {
    // `get` answering "no such PR" is an answer about the number, not about the
    // checkout: a log row whose PR the forge has never heard of is one this body
    // cannot call done.
    const seen = harness(fakeForge({ rows: [] }), { projection: [prRow({ merged: false })], worktrees: [worktreeRow()] })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
  })
})

describe('a cancelled Work keeps its decision (§5.1, §9)', () => {
  it('collects the checkout without moving the Work to `cleaned`', async () => {
    // The PR merged, but a person dropped the Work: `cancelled` is terminal and is
    // theirs. The checkout is still the fleet's to take back, and the Work is not
    // the collector's to rewrite.
    const seen = harness(fakeForge(), {
      projection: [prRow()],
      work: [workRow({ state: 'cancelled' })],
      worktrees: [worktreeRow()],
    })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [PATH])
    assert.deepEqual(typesOf(seen.store), ['worktree.removed'], 'no transition for a terminal Work')
    assert.equal(outcome.actions, 1)
  })

  it('does not write a second `cleaned` for a Work already cleaned', async () => {
    const seen = harness(fakeForge(), {
      projection: [prRow()],
      work: [workRow({ state: 'cleaned' })],
      worktrees: [worktreeRow()],
    })

    await seen.run(scheduleContext())

    assert.deepEqual(typesOf(seen.store), ['worktree.removed'])
  })
})

describe('local-only work is never deleted (§9)', () => {
  it('keeps a dirty checkout and tells the owner', async () => {
    const seen = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow({ dirty: true })] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.deepEqual(typesOf(seen.store), [], 'nothing was removed, so nothing is recorded')
    assert.equal(seen.mailbox.sent.length, 1)
    assert.match(String(seen.mailbox.sent[0]?.body), /uncommitted changes; it was kept/)
    assert.equal(seen.mailbox.sent[0]?.to, ENGINEER)
    assert.equal(outcome.actions, 1)
  })

  it('keeps an unpushed checkout and tells the owner', async () => {
    const seen = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow({ unpushed: true })] })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.match(String(seen.mailbox.sent[0]?.body), /commits that were never pushed; it was kept/)
  })

  it('keeps a dirty checkout even for a PR that closed without merging', async () => {
    const closed = prRow({ merged: false })
    const seen = harness(forgeSaying('closed', [closed]), {
      projection: [closed],
      worktrees: [worktreeRow({ dirty: true })],
    })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.equal(seen.mailbox.sent.length, 1)
  })
})

describe('holders are reported, never killed — and never release a checkout (§9)', () => {
  it('keeps the checkout a live process is sitting in, and tells the owner', async () => {
    const seen = harness(fakeForge(), {
      projection: [prRow()],
      worktrees: [worktreeRow({ holders: [{ pid: 4242, command: 'node dev' }] })],
      alive: [4242],
    })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.match(String(seen.mailbox.sent[0]?.body), /in use \(node dev\)/)
    assert.equal(outcome.actions, 1)
  })

  it('keeps the checkout when every recorded holder has exited, and says they are leftovers', async () => {
    // The row is the last scan's photograph, and the checkout may have a process in
    // it that started after the picture was taken. So a dead pid does not make the
    // checkout empty: it is reported as a leftover, and the scan that clears the row
    // is what releases it.
    const seen = harness(fakeForge(), {
      projection: [prRow()],
      worktrees: [worktreeRow({ holders: [{ pid: 4242, command: 'node dev' }] })],
      alive: [],
    })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.deepEqual(typesOf(seen.store), [])
    assert.match(String(seen.mailbox.sent[0]?.body), /last seen in use \(node dev\)/)
  })

  it('keeps the checkout when one of two holders is still running', async () => {
    const seen = harness(fakeForge(), {
      projection: [prRow()],
      worktrees: [worktreeRow({ holders: [{ pid: 111, command: 'node serve' }, { pid: 222, command: 'pnpm test' }] })],
      alive: [222],
    })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.match(String(seen.mailbox.sent[0]?.body), /pnpm test/)
    assert.doesNotMatch(String(seen.mailbox.sent[0]?.body), /node serve/)
  })
})

describe('what the ports being absent means (§1.1, §9)', () => {
  it('records the removal and throws without a Mailbox', async () => {
    const seen = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow()], without: ['mailbox'] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [PATH])
    assert.deepEqual(typesOf(seen.store), ['worktree.removed', 'work.cleaned'])
    assert.equal(outcome.actions, 1)
  })

  it('keeps and wakes nobody when a checkout with local-only work has no Mailbox', async () => {
    const seen = harness(fakeForge(), {
      projection: [prRow()],
      worktrees: [worktreeRow({ dirty: true })],
      without: ['mailbox'],
    })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.equal(outcome.actions, 0, 'nobody was told, so no action was taken')
  })

  it('never claims a removal it could not make without §9’s manager', async () => {
    const seen = harness(fakeForge(), {
      projection: [prRow()],
      worktrees: [worktreeRow()],
      without: ['worktrees'],
    })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(typesOf(seen.store), [], 'a log that says a checkout is gone while it is on disk is worse than no log')
    assert.equal(outcome.actions, 0)
  })

  it('is silent and does not throw when the checkout has no owning Work', async () => {
    const orphan = prRow({ workId: undefined })
    const seen = harness(fakeForge(), { projection: [orphan], work: [], worktrees: [worktreeRow({ ownerPeerId: undefined })] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [PATH], 'the checkout is still a fact worth handling')
    assert.deepEqual(typesOf(seen.store), ['worktree.removed'], 'no one to mark `cleaned`, and nobody invented')
    assert.equal(seen.mailbox.sent.length, 0)
    assert.equal(outcome.actions, 1)
  })

  it('reports a git refusal to the owner and records nothing', async () => {
    const manager = fakeWorktrees()
    manager.refuse = true
    const seen = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow()], manager })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(typesOf(seen.store), [])
    assert.match(String(seen.mailbox.sent[0]?.body), /could not be removed/)
    assert.equal(outcome.actionsFailed, 1)
  })
})

describe('the merge event’s half (§6)', () => {
  it('collects just the checkout the merged PR names', async () => {
    const other = worktreeRow({
      worktreeId: OTHER_WORKTREE,
      branch: 'fleet/work-2',
      path: '/repo/.claude/worktrees/fleet/work-2',
    })
    const seen = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow(), other] })
    const outcome = await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.worktrees.removed, [PATH], 'the second checkout is the sweep’s business')
    assert.deepEqual(typesOf(seen.store), ['worktree.removed', 'work.cleaned'])
    assert.equal(outcome.actions, 1)
  })

  it('finishes a Work whose checkout `branch-cleanup` already took', async () => {
    // The ordinary `work.merged` wake. `branch-cleanup` ran on the `pr.merged` before it,
    // removed the checkout with the branch, and could not write the transition because the
    // Work was still `mergeable` then. Nothing is left to remove, and the Work is still owed
    // its last step — without this it would sit at `merged` with nobody left to move it.
    const seen = harness(fakeForge(), { projection: [prRow()], worktrees: [] })
    const outcome = await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.worktrees.removed, [])
    assert.deepEqual(typesOf(seen.store), ['work.cleaned'])
    assert.equal(outcome.actions, 1)
  })

  it('does not finish a Work the log has not merged, even with no checkout left', async () => {
    const seen = harness(fakeForge(), { projection: [prRow()], work: [workRow({ state: 'mergeable' })], worktrees: [] })

    await seen.run(eventContext(workMerged()))

    assert.deepEqual(typesOf(seen.store), [])
  })

  it('does nothing when the projection does not say the PR merged', async () => {
    const seen = harness(fakeForge(), { projection: [prRow({ merged: false })], worktrees: [worktreeRow()] })
    const outcome = await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.worktrees.removed, [])
    assert.equal(outcome.actions, 0)
    assert.deepEqual(seen.forge.asked, [], 'the event path never asks the forge: the log said merged')
  })

  it('keeps the checkout when a holder is recorded, on the event path too', async () => {
    const seen = harness(fakeForge(), {
      projection: [prRow()],
      worktrees: [worktreeRow({ holders: [{ pid: 4242, command: 'node dev' }] })],
      alive: [4242],
    })

    await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.worktrees.removed, [])
    assert.match(String(seen.mailbox.sent[0]?.body), /in use/)
  })
})

describe('the sweep reads once and hashes what it read (§5.4)', () => {
  it('asks the forge about each PR once per run', async () => {
    const second = worktreeRow({
      worktreeId: OTHER_WORKTREE,
      branch: 'fleet/work-2',
      path: '/repo/.claude/worktrees/fleet/work-2',
    })
    const prs = [
      prRow({ merged: false }),
      parse(pullRequestSchema(), { ...prRow({ merged: false }), number: 13, head: 'fleet/work-2' }),
    ]
    const forge = fakeForge({ rows: prs, states: { 12: 'open', 13: 'open' } })
    const seen = harness(forge, { projection: prs, worktrees: [worktreeRow(), second] })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.forge.asked, [12, 13], 'one question per checkout, in worktree order')
  })

  it('hashes what it read, so two identical sweeps hash the same (§5.4)', async () => {
    const one = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow()] })
    const two = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow()] })
    assert.equal((await one.run(scheduleContext())).inputsHash, (await two.run(scheduleContext())).inputsHash)
  })
})
