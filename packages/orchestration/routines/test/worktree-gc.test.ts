/**
 * `worktree-gc` (§6, §9). §9's rule is a conjunction — the PR is done, the
 * checkout is clean and pushed, nothing live is sitting in it — and the tests are
 * about each term, because each one is a different person's work:
 *
 * - the first is the fleet's own bookkeeping (a merge, or a Work that was dropped
 *   and whose PR closed unmerged),
 * - the second is somebody's afternoon (dirty, or commits never pushed),
 * - the third is somebody's running process, which §9 says `gc` reports and never
 *   kills — and which is a *live* process, not a row: a pid that has since exited
 *   is a leftover, and a checkout kept for one is kept for nothing.
 *
 * The closed case gets its own weight here because it is the one this body owns
 * outright: `branch-cleanup` deletes a merged branch and the checkout that went
 * with it, and nothing in §10 gives a closed branch a deletion at all. So the
 * checkout goes and the branch is left exactly where it is — a test that asserted
 * the forge was never asked to delete anything is the point.
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
 * §9's forge, as far as this body may use it: the open list, which is the only way
 * to learn a PR closed unmerged (§3 has no `pr.closed`). Every write throws, so a
 * test cannot pass by a `gc` run that deleted a branch on its way past a checkout.
 */
interface FakeForge extends PullRequests {
  readonly lists: readonly string[]
}

const fakeForge = (options: { readonly open?: readonly PullRequest[] } = {}): FakeForge => {
  const lists: string[] = []
  const write = (name: string) => async () => {
    throw new Error(`worktree-gc must not call ${name}: it removes checkouts, not refs (§9, §10)`)
  }
  return {
    lists,
    list: async (_named, listOptions) => {
      lists.push(listOptions?.state ?? 'open')
      // A closed PR is not on the open list, whatever the projection still says.
      return options.open ?? []
    },
    get: async (named, number) =>
      (options.open ?? []).find((pr) => String(pr.repo) === String(named) && pr.number === number),
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
  })

  it('removes nothing and says nothing for a PR that is still open', async () => {
    const open = prRow({ merged: false })
    const seen = harness(fakeForge({ open: [open] }), { projection: [open], worktrees: [worktreeRow()] })
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
  })
})

describe('a PR closed without merging (§9, §10)', () => {
  it('removes the checkout and leaves the branch alone', async () => {
    // The row is in the log and no longer on the forge's open list: closed, and not
    // merged. §10 gives that branch no deletion, so only the checkout goes.
    const seen = harness(fakeForge(), { projection: [prRow({ merged: false })], worktrees: [worktreeRow()] })
    const outcome = await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [PATH], 'the checkout is collected')
    assert.deepEqual(typesOf(seen.store), ['worktree.removed'], 'no `work.cleaned`: the Work was dropped, not finished')
    assert.match(String((seen.store.appended[0]?.data as { reason: string }).reason), /closed without merging/)
    assert.equal(outcome.actionsFailed, 0)
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
    const seen = harness(fakeForge(), {
      projection: [prRow({ merged: false })],
      worktrees: [worktreeRow({ dirty: true })],
    })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [])
    assert.equal(seen.mailbox.sent.length, 1)
  })
})

describe('holders are reported, never killed (§9)', () => {
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

  it('removes the checkout when every recorded holder has exited', async () => {
    // The row is the last scan's photograph. A pid that is `ESRCH` now is a
    // leftover, and keeping the checkout for it keeps it forever.
    const seen = harness(fakeForge(), {
      projection: [prRow()],
      worktrees: [worktreeRow({ holders: [{ pid: 4242, command: 'node dev' }] })],
      alive: [],
    })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.worktrees.removed, [PATH])
    assert.deepEqual(typesOf(seen.store), ['worktree.removed', 'work.cleaned'])
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

  it('does nothing when the projection does not say the PR merged', async () => {
    const seen = harness(fakeForge(), { projection: [prRow({ merged: false })], worktrees: [worktreeRow()] })
    const outcome = await seen.run(eventContext(workMerged()))

    assert.deepEqual(seen.worktrees.removed, [])
    assert.equal(outcome.actions, 0)
  })

  it('keeps the checkout when a holder is live, on the event path too', async () => {
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
  it('asks the forge for the open list once per repo', async () => {
    const second = worktreeRow({
      worktreeId: OTHER_WORKTREE,
      branch: 'fleet/work-2',
      path: '/repo/.claude/worktrees/fleet/work-2',
    })
    const prs = [
      prRow({ merged: false }),
      parse(pullRequestSchema(), { ...prRow({ merged: false }), number: 13, head: 'fleet/work-2' }),
    ]
    const seen = harness(fakeForge(), { projection: prs, worktrees: [worktreeRow(), second] })

    await seen.run(scheduleContext())

    assert.deepEqual(seen.forge.lists, ['open'], 'two checkouts on one repo are one question')
  })

  it('hashes what it read, so two identical sweeps hash the same (§5.4)', async () => {
    const one = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow()] })
    const two = harness(fakeForge(), { projection: [prRow()], worktrees: [worktreeRow()] })
    assert.equal((await one.run(scheduleContext())).inputsHash, (await two.run(scheduleContext())).inputsHash)
  })
})
