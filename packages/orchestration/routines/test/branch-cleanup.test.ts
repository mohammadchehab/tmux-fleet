/**
 * `branch-cleanup` (§6, §10). The body is the fleet's only deleter of branches, so
 * the tests are about what it (a) deletes, (b) refuses to delete, and (c) tells a
 * peer — in both of the ways in it has: the merge event and the nightly sweep.
 *
 * The rule that earns most of these cases is §10's, rewritten: **no deletion while
 * a dependent exists**. A dependent is retargeted onto the base the merge went
 * into and the branch goes; a dependent that cannot move keeps the branch alive.
 * The second rule is the pin: a branch that moved past the sha a merge recorded is
 * work the merge never saw, and `deleteBranch` refuses it rather than the routine
 * guessing.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  fleetError,
  ok,
  parse,
  peerId,
  repo,
  sha,
  workId,
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
  type Branch,
  type FleetEvent,
  type Mailbox,
  type OutboundMessage,
  type Peer,
  type PullRequest,
  type PullRequests,
  type Work,
  type Worktree,
  type Worktrees,
} from '@fleet/foundation-contracts'
import type { RoutineContext, RoutineOutcome } from '../src/routine.ts'
import { cleanup } from '../src/routines/branch-cleanup.ts'
import { AT, fakeRead, fakeStore, movableClock, type FakeStore } from './support/fakes.ts'

const REPO: Repo = parse(repo(), 'acme/widgets')
const OTHER: Repo = parse(repo(), 'acme/other')
const HEAD: Sha = parse(sha(), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
const MOVED: Sha = parse(sha(), 'f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d')
const ENGINEER: PeerId = parse(peerId(), 'engineer-1')
const WORK: WorkId = parse(workId(), 'wrk_0123456789abcdef')
const BRANCH = 'fleet/work-1'

const eventContext = (event: FleetEvent): RoutineContext => ({
  routineId: 'branch-cleanup',
  kind: 'branch-cleanup',
  trigger: 'event',
  at: AT,
  clock: movableClock(),
  event,
})

const scheduleContext = (): RoutineContext => ({
  routineId: 'branch-cleanup',
  kind: 'branch-cleanup',
  trigger: 'schedule',
  at: AT,
  clock: movableClock(),
})

/** `work.merged`, built through the registry's own schema (§3). */
const workMerged = (headSha: Sha = HEAD, seq = 7): FleetEvent =>
  parse(eventSchemaFor('work.merged')!, {
    seq,
    ts: AT,
    type: 'work.merged',
    subject: String(WORK),
    actor: 'scheduler',
    data: { workId: WORK, pr: { repo: REPO, number: 12 }, headSha },
  }) as FleetEvent

/**
 * `pr.merged`, built through the registry's own schema (§3) — the wake that arrives
 * *before* `work-sync` has turned the PR into a `work.merged`.
 */
const prMerged = (headSha: Sha = HEAD, seq = 8): FleetEvent =>
  parse(eventSchemaFor('pr.merged')!, {
    seq,
    ts: AT,
    type: 'pr.merged',
    subject: `${String(REPO)}#12`,
    actor: 'scheduler',
    data: { pr: { repo: REPO, number: 12 }, headSha },
  }) as FleetEvent

/** The merged PR as the projection holds it (§3). */
const mergedPr = (fields: Partial<PullRequest> = {}): PullRequest =>
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
    path: `/repo/.claude/worktrees/${BRANCH}`,
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
 * §10's port, over what a test says the remote holds. `deleteBranch` enforces the
 * pin the way both adapters do — compare, refuse with `head_moved`, never delete
 * — so a test cannot pass by the fake being more forgiving than the forge.
 */
interface FakeForge extends PullRequests {
  readonly deleted: readonly { readonly branch: string; readonly sha: Sha }[]
  readonly retargeted: readonly { readonly number: number; readonly base: string }[]
  readonly lists: readonly string[]
  /** Make the next `deleteBranch` fail for a reason other than the pin. */
  breakDelete(message?: string): void
  /** Make `retarget` refuse — a dependent that will not move (a closed PR, a permissions error). */
  refuseRetarget: boolean
}

const fakeForge = (
  options: {
    readonly prs?: readonly PullRequest[]
    readonly branches?: readonly Branch[]
    readonly closed?: readonly PullRequest[]
    /** What the forge reports as trunk. `main` unless a test says otherwise. */
    readonly defaultBranch?: string
  } = {},
): FakeForge => {
  const deleted: { branch: string; sha: Sha }[] = []
  const retargeted: { number: number; base: string }[] = []
  const lists: string[] = []
  const prs = [...(options.prs ?? [])]
  let branches = [...(options.branches ?? [{ name: BRANCH, sha: HEAD }])]
  let failure: string | undefined
  const forge: FakeForge = {
    deleted,
    retargeted,
    lists,
    refuseRetarget: false,
    breakDelete: (message = 'gh: HTTP 403') => {
      failure = message
    },
    list: async (named: Repo, listOptions) => {
      lists.push(`${String(named)}:${listOptions?.state ?? 'open'}`)
      const rows = listOptions?.state === 'all' ? [...prs, ...(options.closed ?? [])] : prs
      return rows.filter((pr) => String(pr.repo) === String(named))
    },
    get: async (named: Repo, number: number) =>
      prs.find((pr) => String(pr.repo) === String(named) && pr.number === number),
    searchIntent: async () => [],
    create: async () => {
      throw new Error('branch-cleanup must not open a PR')
    },
    checks: async () => ({ state: 'passing', failing: [] }),
    review: async () => ({ state: 'approved' }),
    retarget: async (_repo, number, base) => {
      if (forge.refuseRetarget) throw new Error('gh: cannot retarget a closed PR')
      retargeted.push({ number, base })
      const row = prs.findIndex((pr) => pr.number === number)
      if (row >= 0) prs[row] = { ...prs[row]!, base }
    },
    dependents: async () => [],
    merge: async () => ({}),
    branches: async (named: Repo) => branches.filter(() => String(named) === String(REPO)),
    defaultBranch: async () => options.defaultBranch ?? 'main',
    deleteBranch: async (named: Repo, branch: string, expectedSha: Sha) => {
      if (failure !== undefined) {
        const message = failure
        failure = undefined
        throw fleetError('external_failed', message)
      }
      const found = branches.find((entry) => entry.name === branch)
      if (found === undefined) throw fleetError('not_found', `${String(named)} has no branch ${branch}`)
      if (found.sha !== expectedSha) {
        throw fleetError('head_moved', `${branch} points at ${String(found.sha)}, not ${String(expectedSha)}`)
      }
      deleted.push({ branch, sha: expectedSha })
      branches = branches.filter((entry) => entry.name !== branch)
    },
  }
  return forge
}

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
      return ok(`msg_${String(sent.length).padStart(16, '0')}` as never) as Result<never, never>
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
    create: async () => ({
      path: '/repo/.claude/worktrees/work-test',
      branch: 'work-test',
    }),
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
  const run = async (context: RoutineContext) => {
    const outcome = await cleanup(
      { read: rows, pullRequests: forge, store, mailbox, worktrees, repos: [REPO] },
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

describe('the merge event (§10)', () => {
  it('deletes the merged branch, pinned to the sha the merge recorded', async () => {
    const seen = harness(fakeForge(), { projection: [mergedPr()] })
    const outcome = await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.forge.deleted, [{ branch: BRANCH, sha: HEAD }])
    assert.deepEqual(typesOf(seen.store), ['branch.deleted'])
    assert.deepEqual(seen.store.appended[0]?.data, { repo: REPO, branch: BRANCH, sha: HEAD, by: 'work.merged' })
    assert.equal(outcome.actionsFailed, 0)
  })

  it('moves a dependent onto the base the merge went into, then deletes (§10)', async () => {
    const stack = parse(pullRequestSchema(), {
      ...mergedPr(),
      number: 13,
      base: BRANCH,
      head: 'fleet/work-2',
      merged: false,
    })
    const seen = harness(fakeForge({ prs: [stack] }), { projection: [mergedPr()] })
    await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.forge.retargeted, [{ number: 13, base: 'main' }])
    assert.deepEqual(seen.forge.deleted, [{ branch: BRANCH, sha: HEAD }])
  })

  it('keeps the branch when a dependent cannot move, and says why (§10)', async () => {
    const stack = parse(pullRequestSchema(), {
      ...mergedPr(),
      number: 13,
      base: BRANCH,
      head: 'fleet/work-2',
      merged: false,
    })
    const forge = fakeForge({ prs: [stack] })
    forge.refuseRetarget = true
    const seen = harness(forge, { projection: [mergedPr()] })
    const outcome = await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.forge.deleted, [], 'a branch with a dependent is not deleted')
    assert.deepEqual(typesOf(seen.store), [])
    assert.equal(seen.mailbox.sent.length, 1)
    assert.match(String(seen.mailbox.sent[0]?.body), /#13 could not move onto main/)
    assert.equal(outcome.actionsFailed, 1)
  })

  it('refuses a branch that moved past the merged head, and says so', async () => {
    // The remote has commits the merge never saw: `deleteBranch` refuses with
    // `head_moved`, and the routine reports rather than forcing.
    const seen = harness(fakeForge({ branches: [{ name: BRANCH, sha: MOVED }] }), { projection: [mergedPr()] })
    const outcome = await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.forge.deleted, [])
    assert.deepEqual(typesOf(seen.store), [], 'a deletion that did not happen is not recorded as one')
    assert.equal(seen.mailbox.sent.length, 1)
    assert.match(String(seen.mailbox.sent[0]?.body), /was not deleted/)
    assert.equal(outcome.actionsFailed, 1)
  })

  it('never deletes a trunk branch, whatever the event says', async () => {
    const seen = harness(fakeForge({ branches: [{ name: 'main', sha: HEAD }] }), {
      projection: [mergedPr({ head: 'main', base: 'release' })],
    })
    await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.forge.deleted, [])
    assert.match(String(seen.mailbox.sent[0]?.body), /trunk branch/)
  })

  for (const longLived of ['develop', 'staging', 'release/2.x']) {
    it(`never deletes the long-lived ${longLived} when its release PR merges (TASK-90)`, async () => {
      const release = mergedPr({ head: longLived, base: 'main' })
      const seen = harness(fakeForge({ prs: [release], branches: [{ name: longLived, sha: HEAD }] }), {
        projection: [release],
      })
      await seen.run(eventContext(workMerged()))

      assert.deepEqual(seen.forge.deleted, [])
      assert.deepEqual(typesOf(seen.store), [])
    })
  }

  it('does nothing when the projection does not say the PR merged', async () => {
    const seen = harness(fakeForge(), { projection: [mergedPr({ merged: false })] })
    const outcome = await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.forge.deleted, [])
    assert.equal(outcome.actions, 0)
  })
})

describe('the worktree half of the merge (§9)', () => {
  it('removes the checkout of a merged Work and records both facts', async () => {
    const seen = harness(fakeForge(), { projection: [mergedPr()], worktrees: [worktreeRow()] })
    await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.worktrees.removed, [`/repo/.claude/worktrees/${BRANCH}`])
    assert.deepEqual(typesOf(seen.store), ['branch.deleted', 'worktree.removed', 'work.cleaned'])
  })

  it('removes the checkout on a `pr.merged` wake but leaves the Work’s last step to `worktree-gc`', async () => {
    // `pr.merged` is committed before `work-sync` turns it into `work.merged`, and
    // `wake.ts` wakes the scheduler before its listeners run — so on this wake the Work is
    // still `mergeable`. `cleaned` is not this run's to write (§5.1 only lets a merged Work
    // through, and the projector would refuse it on the *ordinary* path). The checkout goes
    // with the branch; the `work.merged` wake that follows finishes the Work.
    const seen = harness(fakeForge(), {
      projection: [mergedPr()],
      work: [workRow({ state: 'mergeable' })],
      worktrees: [worktreeRow()],
    })
    const outcome = await seen.run(eventContext(prMerged()))

    assert.deepEqual(seen.worktrees.removed, [`/repo/.claude/worktrees/${BRANCH}`])
    assert.deepEqual(typesOf(seen.store), ['branch.deleted', 'worktree.removed'], 'no transition for a Work that has not merged')
    assert.equal(outcome.actionsFailed, 0)
  })

  it('keeps a dirty checkout and tells the owner (§9)', async () => {
    const seen = harness(fakeForge(), {
      projection: [mergedPr()],
      worktrees: [worktreeRow({ dirty: true })],
    })
    await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.worktrees.removed, [])
    assert.deepEqual(typesOf(seen.store), ['branch.deleted'], 'the branch still goes; only the checkout stays')
    assert.match(String(seen.mailbox.sent[0]?.body), /uncommitted changes; it was kept/)
  })

  it('keeps a checkout a process is sitting in (§9)', async () => {
    const seen = harness(fakeForge(), {
      projection: [mergedPr()],
      worktrees: [worktreeRow({ holders: [{ pid: 4242, command: 'node dev' }] })],
    })
    await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.worktrees.removed, [])
    assert.match(String(seen.mailbox.sent[0]?.body), /in use \(node dev\)/)
  })

  it('says so when git refuses, and records nothing it did not do', async () => {
    const manager = fakeWorktrees()
    manager.refuse = true
    const seen = harness(fakeForge(), { projection: [mergedPr()], worktrees: [worktreeRow()], manager })
    await seen.run(eventContext(workMerged()))

    assert.deepEqual(typesOf(seen.store), ['branch.deleted'])
    assert.match(String(seen.mailbox.sent[0]?.body), /could not be removed/)
  })
})

describe('the nightly sweep (§6)', () => {
  it('deletes a branch whose head equals a merged PR’s head', async () => {
    const seen = harness(fakeForge({ prs: [mergedPr()] }), { projection: [mergedPr()] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.forge.deleted, [{ branch: BRANCH, sha: HEAD }])
    assert.equal(outcome.actionsFailed, 0)
    assert.equal((seen.store.appended[0]?.data as { by: string }).by, 'sweep')
  })

  it('leaves a branch with commits after the merge, and tells the owner', async () => {
    const seen = harness(fakeForge({ prs: [mergedPr()], branches: [{ name: BRANCH, sha: MOVED }] }), {
      projection: [mergedPr()],
    })
    await seen.run(scheduleContext())

    assert.deepEqual(seen.forge.deleted, [])
    assert.equal(seen.mailbox.sent.length, 1)
    assert.match(String(seen.mailbox.sent[0]?.body), /commits after the merge/)
  })

  it('leaves a branch whose PR was closed without merging, and tells the owner', async () => {
    const closed = parse(pullRequestSchema(), { ...mergedPr(), merged: false })
    const seen = harness(fakeForge({ closed: [closed] }), { projection: [] })
    await seen.run(scheduleContext())

    assert.deepEqual(seen.forge.deleted, [])
    assert.equal(seen.mailbox.sent.length, 1)
    assert.match(String(seen.mailbox.sent[0]?.body), /closed without merging/)
  })

  it('says nothing about a branch the fleet has no PR for', async () => {
    const seen = harness(fakeForge({ branches: [{ name: 'someone/else', sha: HEAD }] }), { projection: [] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.forge.deleted, [])
    assert.equal(seen.mailbox.sent.length, 0)
    assert.equal(outcome.actions, 0)
  })

  it('never deletes a trunk branch, even when a merged PR names it as a head', async () => {
    const seen = harness(fakeForge({ prs: [mergedPr({ head: 'main', base: 'release' })], branches: [{ name: 'main', sha: HEAD }] }), {
      projection: [mergedPr()],
    })
    await seen.run(scheduleContext())

    assert.deepEqual(seen.forge.deleted, [])
  })

  it('never deletes the trunk a repository actually has, whatever it is called', async () => {
    // `develop` is trunk here, and no denylist of conventions would have said so.
    const seen = harness(
      fakeForge({ prs: [mergedPr({ head: 'develop', base: 'release' })], branches: [{ name: 'develop', sha: HEAD }], defaultBranch: 'develop' }),
      { projection: [mergedPr({ head: 'develop', base: 'release' })] },
    )
    await seen.run(scheduleContext())

    // A trunk branch is not a mistake to report: nothing happens, and nobody is told.
    assert.deepEqual(seen.forge.deleted, [])
    assert.equal(seen.mailbox.sent.length, 0)
  })

  for (const longLived of ['develop', 'staging', 'release/2.x']) {
    it(`never deletes the long-lived ${longLived} after a release PR from it merges (TASK-90)`, async () => {
      // The repo's trunk is `main`; `${longLived}` is the integration branch a release PR is cut from.
      const release = mergedPr({ head: longLived, base: 'main' })
      const seen = harness(fakeForge({ prs: [release], branches: [{ name: longLived, sha: HEAD }] }), {
        projection: [release],
      })
      await seen.run(scheduleContext())

      assert.deepEqual(seen.forge.deleted, [])
      assert.deepEqual(typesOf(seen.store), [])
    })
  }

  it('keeps the checkout when the delete failed, because the branch is still there', async () => {
    const seen = harness(fakeForge({ prs: [mergedPr()] }), {
      projection: [mergedPr()],
      worktrees: [worktreeRow()],
    })
    seen.forge.breakDelete('gh: HTTP 403')
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.forge.deleted, [])
    assert.deepEqual(seen.worktrees.removed, [])
    assert.equal(outcome.actionsFailed, 1)
  })

  it('asks for the branches and the closed PRs, once per repo', async () => {
    const seen = harness(fakeForge({ prs: [mergedPr()] }), { projection: [mergedPr()] })
    await seen.run(scheduleContext())
    assert.deepEqual(seen.forge.lists, ['acme/widgets:all'])
  })

  it('hashes what it read, so two identical sweeps hash the same (§5.4)', async () => {
    const one = harness(fakeForge({ prs: [mergedPr()] }), { projection: [mergedPr()] })
    const two = harness(fakeForge({ prs: [mergedPr()] }), { projection: [mergedPr()] })
    assert.equal((await one.run(scheduleContext())).inputsHash, (await two.run(scheduleContext())).inputsHash)
  })
})
