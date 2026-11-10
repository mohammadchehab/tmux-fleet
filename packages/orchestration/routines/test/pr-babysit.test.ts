/**
 * `pr-babysit` (§6, §10). The body is the fleet's only reader of the forge, so the
 * tests are about what it (a) records, (b) refuses to record, and (c) tells a peer.
 *
 * The rule that earns most of these cases is §10's pin: a checks observation is
 * recorded only against a head the log already holds, so the projection can never say
 * "green" about a commit the fleet cannot identify. That is why a new PR and a moved
 * head produce one `pr.opened` and no checks, and why the *next* poll records them —
 * it has a row on that head to compare the observation against.
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
  type Sha,
  type WorkId,
} from '@fleet/foundation-core'
import {
  appendIssues,
  peer as peerSchema,
  pullRequest as pullRequestSchema,
  work as workSchema,
  type AppendEvent,
  type Mailbox,
  type OutboundMessage,
  type Peer,
  type PullRequest,
  type PullRequests,
  type Work,
} from '@fleet/foundation-contracts'
import type { RoutineContext, RoutineOutcome } from '../src/routine.ts'
import { babysit } from '../src/routines/pr-babysit.ts'
import { AT, fakeRead, fakeStore, movableClock, type FakeStore } from './support/fakes.ts'

const REPO: Repo = parse(repo(), 'acme/widgets')
const OTHER: Repo = parse(repo(), 'acme/other')
const HEAD: Sha = parse(sha(), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
const MOVED: Sha = parse(sha(), 'f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d')
const ENGINEER: PeerId = parse(peerId(), 'engineer-1')
const WORK: WorkId = parse(workId(), 'wrk_0123456789abcdef')

const contextOf = (): RoutineContext => ({
  routineId: 'pr-babysit',
  kind: 'pr-babysit',
  trigger: 'heartbeat',
  at: AT,
  clock: movableClock(),
})

/** One observation as the port hands it back: head, checks and review from one `gh` read. */
const observed = (fields: Partial<PullRequest> = {}): PullRequest =>
  parse(pullRequestSchema(), {
    repo: REPO,
    number: 12,
    base: 'main',
    head: 'fleet/work-1',
    headSha: HEAD,
    checks: 'pending',
    failingChecks: [],
    review: 'pending',
    merged: false,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  })

/** The same PR as the projection already holds it (`observed` is the same shape, §3). */
const recorded = (fields: Partial<PullRequest> = {}): PullRequest => observed(fields)

const workRow = (fields: Partial<Work> = {}): Work =>
  parse(workSchema(), {
    workId: WORK,
    title: 'wire the mailer',
    state: 'assigned',
    assignee: ENGINEER,
    dependsOn: [],
    prs: [{ repo: REPO, number: 12 }],
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  })

const peerRow = (fields: Partial<Peer> = {}): Peer =>
  parse(peerSchema(), {
    peerId: ENGINEER,
    role: 'engineer',
    providerId: 'claude',
    model: 'sonnet',
    permissionMode: 'default',
    briefVersion: 3,
    state: 'working',
    registeredAt: AT,
    updatedAt: AT,
    ...fields,
  })

/**
 * The forge's port, over rows a test sets. `pr-babysit` reads with `list` and, to
 * tell a closed PR from a merged one, `get` — every other method throws, so a routine
 * that merged or retargeted would fail here rather than quietly duplicating a job the
 * gate and the PM own (§10).
 */
interface FakeGithub extends PullRequests {
  readonly listed: readonly string[]
  readonly read: readonly string[]
  /** Make every read fail, the way a `gh` that is not installed or not logged in does. */
  break(): void
}

const fakeGithub = (
  rows: readonly PullRequest[],
  options: { readonly vanished?: readonly PullRequest[] } = {},
): FakeGithub => {
  const listed: string[] = []
  const read: string[] = []
  let broken = false
  const verboten = (name: string) => async (): Promise<never> => {
    throw new Error(`pr-babysit must not call ${name}: decisions are the PM's and the gate's (§5.2, §10)`)
  }
  return {
    listed,
    read,
    break: () => {
      broken = true
    },
    list: async (named: Repo) => {
      if (broken) throw new Error('gh: not logged in')
      listed.push(String(named))
      return rows
    },
    get: async (named: Repo, number: number) => {
      if (broken) throw new Error('gh: not logged in')
      read.push(`${String(named)}#${number}`)
      return options.vanished?.find(
        (row) => String(row.repo) === String(named) && row.number === number,
      )
    },
    searchIntent: verboten('searchIntent') as never,
    create: verboten('create') as never,
    checks: verboten('checks') as never,
    review: verboten('review') as never,
    retarget: verboten('retarget') as never,
    dependents: verboten('dependents') as never,
    merge: verboten('merge') as never,
  }
}

/** §7's box, recording what it was handed. */
interface FakeMailbox extends Mailbox {
  readonly sent: readonly OutboundMessage[]
  readonly delivered: readonly PeerId[]
  /** Make the next `send` fail, the way a Mailbox with no such peer does. */
  refuseSend(): void
  /** Make the next `deliver` report the message as not put in front of the peer. */
  undeliverable(): void
}

const fakeMailbox = (): FakeMailbox => {
  const sent: OutboundMessage[] = []
  const delivered: PeerId[] = []
  let refusingSend = false
  let refused = false
  return {
    sent,
    delivered,
    refuseSend: () => {
      refusingSend = true
    },
    undeliverable: () => {
      refused = true
    },
    send: async (message) => {
      if (refusingSend) {
        refusingSend = false
        return err()
      }
      sent.push(message)
      return ok(`msg_${String(sent.length).padStart(16, '0')}` as never)
    },
    deliver: async (to) => {
      delivered.push(to)
      const msgId = `msg_${String(sent.length).padStart(16, '0')}` as never
      return ok({
        peerId: to,
        delivered: refused ? [] : [msgId],
        resumed: false,
        failures: refused ? [{ msgId, reason: 'no_session' as const }] : [],
      })
    },
    pending: async () => [],
    ack: async () => ok(undefined),
    reject: async () => ok(undefined),
    history: async () => [],
  }
}

const err = () => ({ ok: false as const, error: fleetError('provider_failed', 'the provider refused it') })

interface Harness {
  readonly github: FakeGithub
  readonly mailbox: FakeMailbox
  readonly store: FakeStore
  readonly rows: ReturnType<typeof fakeRead>
  readonly run: (repos?: readonly Repo[]) => Promise<RoutineOutcome>
}

const harness = (
  prs: readonly PullRequest[],
  options: {
    readonly projection?: readonly PullRequest[]
    readonly work?: readonly Work[]
    readonly peers?: readonly Peer[]
    /** PRs that left the open list, as a re-read reports them (`get`). */
    readonly vanished?: readonly PullRequest[]
  } = {},
): Harness => {
  const github = fakeGithub(prs, options.vanished === undefined ? {} : { vanished: options.vanished })
  const mailbox = fakeMailbox()
  const store = fakeStore()
  const rows = fakeRead({
    ...(options.projection === undefined ? {} : { pullRequests: options.projection }),
    ...(options.work === undefined ? {} : { work: options.work }),
    ...(options.peers === undefined ? {} : { peers: options.peers }),
  })
  const run = async (repos: readonly Repo[] = [REPO]) => {
    const outcome = await babysit({ read: rows, pullRequests: github, store, mailbox, repos }, contextOf())
    // Every fact is an event, and every event one the store would accept (§3).
    for (const event of store.appended) {
      assert.deepEqual(appendIssues(event), [], `the store would refuse ${event.type}`)
    }
    return outcome
  }
  return { github, mailbox, store, rows, run }
}

const typesOf = (store: FakeStore): readonly string[] =>
  store.appended.map((event: AppendEvent): string => event.type)

describe('what pr-babysit records (§6, §10)', () => {
  it('writes pr.opened for a PR the fleet has never seen, and no checks at an unknown head', async () => {
    const seen = harness([observed({ checks: 'passing', review: 'approved', workId: String(WORK) })])
    const outcome = await seen.run()

    assert.deepEqual(typesOf(seen.store), ['pr.opened'])
    assert.deepEqual(seen.store.appended[0]?.data, {
      pr: { repo: REPO, number: 12 },
      base: 'main',
      head: 'fleet/work-1',
      headSha: HEAD,
      workId: WORK,
    })
    assert.equal(outcome.actions, 1)
    assert.equal(outcome.actionsFailed, 0)
  })

  it('places a stacked PR, because the gate needs its parent to retarget it (§10)', async () => {
    const seen = harness([observed({ stackParent: { repo: REPO, number: 9 } })])
    await seen.run()
    assert.deepEqual(seen.store.appended[0]?.data, {
      pr: { repo: REPO, number: 12 },
      base: 'main',
      head: 'fleet/work-1',
      headSha: HEAD,
      stackParent: { repo: REPO, number: 9 },
    })
  })

  it('records a moved head as pr.opened, never as checks (§10)', async () => {
    const seen = harness([observed({ headSha: MOVED, checks: 'failing', failingChecks: ['build'] })], {
      projection: [recorded({ checks: 'passing' })],
    })
    const outcome = await seen.run()
    assert.deepEqual(typesOf(seen.store), ['pr.opened'])
    assert.equal((seen.store.appended[0]?.data as { headSha: Sha }).headSha, MOVED)
    assert.equal(seen.mailbox.sent.length, 0, 'a head the log did not hold has no author to nudge yet')
    assert.equal(outcome.actions, 1)
  })

  it('records checks and review when they differ from the row', async () => {
    const seen = harness([observed({ checks: 'passing', review: 'approved' })], {
      projection: [recorded({ checks: 'pending', review: 'pending' })],
    })
    await seen.run()
    assert.deepEqual(typesOf(seen.store), ['pr.checks_changed', 'pr.review_changed'])
    assert.deepEqual(seen.store.appended[0]?.data, {
      pr: { repo: REPO, number: 12 },
      headSha: HEAD,
      state: 'passing',
      failing: [],
    })
    assert.deepEqual(seen.store.appended[1]?.data, { pr: { repo: REPO, number: 12 }, headSha: HEAD, state: 'approved' })
  })

  it('appends nothing when the poll found the log already right', async () => {
    const seen = harness([observed({ checks: 'passing', review: 'approved' })], {
      projection: [recorded({ checks: 'passing', review: 'approved' })],
    })
    const outcome = await seen.run()
    assert.deepEqual(typesOf(seen.store), [])
    assert.equal(outcome.actions, 0)
    assert.equal(outcome.actionsFailed, 0)
    assert.deepEqual(seen.github.read, [], 'a PR the forge still lists is not re-read')
  })

  it('hashes what it read, so two identical polls hash the same and a run is traceable (§5.4)', async () => {
    const first = harness([observed({ checks: 'passing' })], { projection: [recorded({ checks: 'pending' })] })
    const second = harness([observed({ checks: 'passing' })], { projection: [recorded({ checks: 'pending' })] })
    assert.equal((await first.run()).inputsHash, (await second.run()).inputsHash)
  })

  it('ignores a merged PR: that row is the gate’s to write (§10)', async () => {
    const seen = harness([observed({ merged: true, checks: 'passing' })], {
      projection: [recorded({ checks: 'pending' })],
    })
    const outcome = await seen.run()
    assert.deepEqual(typesOf(seen.store), [])
    assert.equal(outcome.actions, 0)
  })

  it('polls each repo the profile names', async () => {
    const seen = harness([observed()])
    await seen.run([REPO, OTHER])
    assert.deepEqual(seen.github.listed, ['acme/widgets', 'acme/other'])
  })

  it('records pr.merged for a row that left the open list and reads back merged (§10)', async () => {
    const seen = harness([], {
      projection: [recorded({ checks: 'passing' })],
      vanished: [recorded({ merged: true, headSha: MOVED })],
    })
    const outcome = await seen.run()
    assert.deepEqual(typesOf(seen.store), ['pr.merged'])
    assert.deepEqual(seen.store.appended[0]?.data, { pr: { repo: REPO, number: 12 }, headSha: MOVED })
    assert.deepEqual(seen.github.read, ['acme/widgets#12'], 'the re-read is what tells a merge from a close')
    assert.equal(outcome.actions, 1)
  })

  it('appends nothing for a row that left the open list closed unmerged', async () => {
    const seen = harness([], { projection: [recorded()], vanished: [recorded({ merged: false })] })
    const outcome = await seen.run()
    assert.deepEqual(typesOf(seen.store), [], '§3 has no event for a PR that closed unmerged')
    assert.equal(outcome.actions, 0)
    assert.deepEqual(seen.github.read, ['acme/widgets#12'])
  })

  it('does not re-read a row the projection already holds as merged', async () => {
    const seen = harness([], { projection: [recorded({ merged: true })] })
    await seen.run()
    assert.deepEqual(seen.github.read, [])
  })
})

describe('a failed read is a failed run, never an actions: 0 (§6)', () => {
  it('throws when the forge cannot list, so the scheduler records routine.failed', async () => {
    const seen = harness([])
    seen.github.break()
    await assert.rejects(seen.run(), /not logged in/)
  })

  it('throws when the re-read of a vanished PR fails', async () => {
    const seen = harness([], { projection: [recorded()] })
    seen.github.break()
    await assert.rejects(seen.run(), /not logged in/)
  })
})

describe('what pr-babysit tells a peer (§6, §7)', () => {
  it('nudges the Work assignee when checks go red, citing the failing checks', async () => {
    const seen = harness([observed({ checks: 'failing', failingChecks: ['build', 'lint'], workId: String(WORK) })], {
      projection: [recorded({ checks: 'passing' })],
      work: [workRow()],
      peers: [peerRow()],
    })
    const outcome = await seen.run()

    assert.equal(seen.mailbox.sent.length, 1)
    const nudge = seen.mailbox.sent[0]!
    assert.equal(nudge.to, ENGINEER)
    assert.equal(nudge.from, 'scheduler', 'a routine speaks for the fleet; nothing decided this message (§5.2)')
    assert.equal(nudge.kind, 'nudge')
    assert.equal(nudge.briefVersion, 3)
    assert.match(nudge.body, /build, lint/)
    assert.match(nudge.body, /acme\/widgets#12/)
    assert.match(nudge.body, /the sha it saw pass/)
    assert.deepEqual(nudge.causedBy, [1], 'the message cites the event that caused it (§3)')
    // Delivered in the same run: a nudge that waits is a nudge about the past (§7).
    assert.deepEqual(seen.mailbox.delivered, [ENGINEER])
    assert.equal(outcome.actionsFailed, 0)
  })

  it('does not nudge again while the PR stays red', async () => {
    const seen = harness([observed({ checks: 'failing', failingChecks: ['build'], workId: String(WORK) })], {
      projection: [recorded({ checks: 'failing', failingChecks: ['build'] })],
      work: [workRow()],
      peers: [peerRow()],
    })
    const outcome = await seen.run()
    assert.equal(seen.mailbox.sent.length, 0)
    assert.equal(outcome.actions, 0)
  })

  it('records the failure without nudging when no peer is assigned the Work', async () => {
    const seen = harness([observed({ checks: 'failing', failingChecks: ['build'], workId: String(WORK) })], {
      projection: [recorded({ checks: 'passing' })],
      work: [workRow({ assignee: undefined })],
      peers: [peerRow()],
    })
    const outcome = await seen.run()
    assert.deepEqual(typesOf(seen.store), ['pr.checks_changed'])
    assert.equal(seen.mailbox.sent.length, 0, 'an invented recipient is worse than silence')
    assert.deepEqual([outcome.actions, outcome.actionsFailed], [1, 0])
  })

  it('records the failure without nudging when the PR names no Work', async () => {
    const seen = harness([observed({ checks: 'failing', failingChecks: ['build'] })], {
      projection: [recorded({ checks: 'passing' })],
      work: [workRow()],
      peers: [peerRow()],
    })
    const outcome = await seen.run()
    assert.equal(seen.mailbox.sent.length, 0)
    assert.deepEqual([outcome.actions, outcome.actionsFailed], [1, 0])
  })

  it('counts a peer with no brief to cite as a failed action, keeping the fact', async () => {
    const seen = harness([observed({ checks: 'failing', failingChecks: ['build'], workId: String(WORK) })], {
      projection: [recorded({ checks: 'passing' })],
      work: [workRow()],
      peers: [],
    })
    const outcome = await seen.run()
    assert.deepEqual(typesOf(seen.store), ['pr.checks_changed'])
    assert.equal(seen.mailbox.sent.length, 0)
    assert.equal(outcome.actionsFailed, 1)
  })

  it('counts a delivery the provider refused as a failed action (§7 at-least-once)', async () => {
    const seen = harness([observed({ checks: 'failing', failingChecks: ['build'], workId: String(WORK) })], {
      projection: [recorded({ checks: 'passing' })],
      work: [workRow()],
      peers: [peerRow()],
    })
    seen.mailbox.undeliverable()
    const outcome = await seen.run()
    assert.equal(seen.mailbox.sent.length, 1, 'the message is in the box; the run reports it could not land it')
    assert.equal(outcome.actionsFailed, 1)
  })

  it('counts a Mailbox that would not accept the message as a failure', async () => {
    const seen = harness([observed({ checks: 'failing', failingChecks: ['build'], workId: String(WORK) })], {
      projection: [recorded({ checks: 'passing' })],
      work: [workRow()],
      peers: [peerRow()],
    })
    seen.mailbox.refuseSend()
    const outcome = await seen.run()
    assert.deepEqual(typesOf(seen.store), ['pr.checks_changed'], 'the fact stands even when the message does not')
    assert.equal(outcome.actionsFailed, 1)
  })
})

describe('facts, not decisions (§5.2, §6)', () => {
  it('leaves a green, approved PR for the PM: it merges nothing itself', async () => {
    const seen = harness([observed({ checks: 'passing', review: 'approved' })], {
      projection: [recorded({ checks: 'pending', review: 'pending' })],
    })
    await seen.run()
    // The two rows `mergeGreenPrs` and `mergeBlocker` read are exactly what was written;
    // the port's `merge` would have thrown if this body had tried to decide (§10).
    assert.deepEqual(typesOf(seen.store), ['pr.checks_changed', 'pr.review_changed'])
  })

  it('places an unknown head, then grades it on the next poll', async () => {
    const red = { checks: 'failing' as const, failingChecks: ['build'], workId: String(WORK) }
    const first = harness([observed(red)], { work: [workRow()], peers: [peerRow()] })
    await first.run()
    assert.deepEqual(typesOf(first.store), ['pr.opened'])

    const second = harness([observed(red)], {
      projection: [recorded()],
      work: [workRow()],
      peers: [peerRow()],
    })
    await second.run()
    assert.deepEqual(typesOf(second.store), ['pr.checks_changed'])
    assert.equal(second.mailbox.sent.length, 1, 'the head the log now holds is the one graded — and nudged')
  })
})
