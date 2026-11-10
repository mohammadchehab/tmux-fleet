/**
 * §15, clause 3: three Work items reach `merged`.
 *
 * This is the clause the first two could not cover. A fleet that comes up
 * (`lifecycle.test.ts`) and a fleet that restarts a peer (`self-purge/limit.test.ts`)
 * both prove the *control* plane; this one proves the plane a Work travels through
 * the state machine of §5.1, all the way to the end, with a real store, a real
 * scheduler, the real PM and the real gate.
 *
 * Three things are substituted, and each for a stated reason:
 *
 * - **The agent**, as everywhere in this harness: no provider runs on a CI box.
 * - **The forge** (`support/fake-forge.ts`): §10's port is `gh`, which a runner
 *   does not have and which would be talking to a real repository if it did. The
 *   gate and the PM are the real ones, so what is proved is their decision, not a
 *   stub agreeing with itself.
 * - **The start of the story.** Work items are seeded as `proposed → ready → assigned`
 *   through the waking sink, because the rules that produce them (the PM's `assign`,
 *   §12's contract gate) are tested where they live; what this file is about begins
 *   at `assigned`. The PR events are likewise written by the test rather than by
 *   `pr-babysit`, whose polling has its own test — including the rule that a row is
 *   recorded only when `matchHeadSha` passes.
 *
 * What is *not* substituted is the part clause 3 exists to prove: the gate merges
 * what §10 allows, the `pr.merged` it writes advances the Work through the listener
 * in `apps/daemon/src/work-sync.ts`, and the Work is `merged` in the projections.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BriefId, PeerId, Repo, Sha, Timestamp, WorkId } from '../../../packages/foundation/core/src/index.ts'
import type {
  AppendEvent,
  ChecksState,
  ReviewState,
} from '../../../packages/foundation/contracts/src/index.ts'
import { createSandbox, until, type SandboxEvent } from '../support/sandbox.ts'
import { createFakeForge } from '../support/fake-forge.ts'

const repo = 'sandbox/tmux-fleet' as Repo
const NOW = '2026-11-10T09:00:00.000Z' as Timestamp

/** Three valid ids; §5.1's `WorkId` is opaque, so a made-up `w-1` would not append. */
const works: readonly WorkId[] = ['wrk_0000000000000001', 'wrk_0000000000000002', 'wrk_0000000000000003'] as WorkId[]

const workFloor = (workId: WorkId, number: number): readonly AppendEvent[] => [
  {
    ts: NOW,
    type: 'work.proposed' as const,
    subject: workId,
    actor: 'user' as const,
    data: { workId, title: `work ${String(number)}`, role: 'engineer', dependsOn: [] },
  },
  { ts: NOW, type: 'work.ready' as const, subject: workId, actor: 'scheduler' as const, data: { workId } },
  {
    ts: NOW,
    type: 'work.assigned' as const,
    subject: workId,
    actor: 'pm' as const,
    data: {
      workId,
      peerId: (number === 1 ? 'engineer-1' : 'engineer-2') as PeerId,
      briefId: `brf_000000000000000${String(number)}` as BriefId,
      briefVersion: 1,
    },
  },
]

const prOpened = (workId: WorkId, number: number, headSha: Sha): AppendEvent => ({
  ts: NOW,
  type: 'pr.opened' as const,
  subject: `${String(repo)}#${String(number)}`,
  actor: 'scheduler' as const,
  data: {
    pr: { repo, number },
    base: 'main',
    head: `work/${String(workId)}`,
    // The same sha the forge reports, so §10's pin has something to match: an
    // event that named a different head would describe a PR that does not exist.
    headSha,
    workId,
  },
})

const prChecks = (number: number, state: ChecksState, headSha: Sha): AppendEvent => ({
  ts: NOW,
  type: 'pr.checks_changed' as const,
  subject: `${String(repo)}#${String(number)}`,
  actor: 'scheduler' as const,
  data: { pr: { repo, number }, headSha, state, failing: state === 'failing' ? ['lint'] : [] },
})

const prReview = (number: number, state: ReviewState, headSha: Sha): AppendEvent => ({
  ts: NOW,
  type: 'pr.review_changed' as const,
  subject: `${String(repo)}#${String(number)}`,
  actor: 'scheduler' as const,
  data: { pr: { repo, number }, headSha, state },
})

const stateOf = (events: readonly SandboxEvent[], workId: WorkId): string | undefined => {
  // The projection is what the daemon reads, but the *state* is a fold over the log;
  // reading it back through the RPC would be reading the same fold with more hops.
  let state: string | undefined
  for (const event of events) {
    if (event.subject !== workId) continue
    if (event.type === 'work.proposed') state = 'proposed'
    if (event.type === 'work.ready') state = 'ready'
    if (event.type === 'work.assigned') state = 'assigned'
    if (event.type === 'work.started') state = 'in_progress'
    if (event.type === 'work.review_requested') state = 'in_review'
    if (event.type === 'work.mergeable') state = 'mergeable'
    if (event.type === 'work.merged') state = 'merged'
  }
  return state
}

test('§15.3: three Work items reach `merged`, and the fleet merged them itself', async (t) => {
  const forge = createFakeForge()
  const sandbox = await createSandbox({
    // `dispatch` is §5.2's PM loop; §10's merge is its rule, and the gate executor
    // it asks is wired unconditionally by `compose`.
    routines: ['dispatch'],
    pullRequests: forge,
  })
  t.after(() => sandbox.stop())
  await sandbox.call('up')

  // §5.1's start of the story, as three Works the PM has already handed over.
  const seeded = works.flatMap((workId, index) => workFloor(workId, index + 1))
  await sandbox.composed.append(seeded)

  for (const [index, workId] of works.entries()) {
    const number = index + 1
    forge.open({ repo, number, workId })
    const row = await forge.get(repo, number)
    assert.ok(row !== undefined)
    const headSha = row.headSha

    // The forge is what the gate reads *at the moment it acts*, so it goes green
    // before the events that make the fleet act — the other order is a PR the PM
    // decides to merge while the forge still says `pending`, which §10 refuses.
    forge.finish(repo, number, 'passing')
    forge.decide(repo, number, 'approved')

    // A PR the peer opened, its checks finishing green, and the review that §10
    // requires. In a real fleet `pr-babysit` writes these three from the forge;
    // here the forge *is* the source, so the test writes what it saw.
    await sandbox.composed.append([
      prOpened(workId, number, headSha),
      prChecks(number, 'passing', headSha),
      prReview(number, 'approved', headSha),
    ])
  }

  // The gate merges each one through the port, and `work-sync` walks each Work
  // the last step of §5.1. Nothing in this test merges.
  const events = await until(async () => {
    const all = await sandbox.events()
    return works.every((workId) => stateOf(all, workId) === 'merged') ? all : undefined
  }, 'three Work items to reach `merged`', 15_000)

  for (const workId of works) assert.equal(stateOf(events, workId), 'merged')

  // The merge was the gate's, not a test's: three `merge()` calls on the port, none
  // of them deleting a branch (§10 forbids it while a dependent could exist).
  assert.equal(forge.merges.length, 3, 'the gate asked the forge to merge each PR')
  for (const merge of forge.merges) {
    assert.equal(merge.method, 'squash')
    assert.equal(merge.deleteBranch, false)
  }

  // §5.1's `merged` is reached through `mergeable`: a Work that jumped straight from
  // `in_review` to `merged` would still end in the right state while skipping §10's
  // precondition, so the log is asked for the intermediate step.
  for (const workId of works) {
    assert.ok(
      events.some((event) => event.subject === workId && event.type === 'work.mergeable'),
      `${String(workId)} was mergeable before it was merged`,
    )
  }
})

test('§10: a red head is never merged, and its Work stays short of `merged`', async (t) => {
  const forge = createFakeForge()
  const sandbox = await createSandbox({ routines: ['dispatch'], pullRequests: forge })
  t.after(() => sandbox.stop())
  await sandbox.call('up')

  const workId = works[0]
  await sandbox.composed.append(workFloor(workId, 1))

  forge.open({ repo, number: 1, workId })
  const row = await forge.get(repo, 1)
  assert.ok(row !== undefined)

  // Checks failing, review approved: §10's first precondition is what stops it, and
  // the Work sits in review rather than moving on.
  forge.finish(repo, 1, 'failing', ['lint'])
  await sandbox.composed.append([
    prOpened(workId, 1, row.headSha),
    prChecks(1, 'failing', row.headSha),
    prReview(1, 'approved', row.headSha),
  ])

  await until(
    async () => (await sandbox.events()).some((event) => event.type === 'work.review_requested'),
    'the Work to be in review',
    5_000,
  )

  const events = await sandbox.events()
  assert.equal(stateOf(events, workId), 'in_review')
  assert.equal(forge.merges.length, 0, 'the gate did not merge a red PR')
  assert.ok(
    !events.some((event) => event.type === 'work.merged'),
    'no Work is merged on a red head',
  )
})
