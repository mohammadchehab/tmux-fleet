import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixedClock, type BriefId, type ContractId, type PeerId, type WorkId } from '@fleet/foundation-core'
import type { AssignAction, ExecuteRequest, Message, SupersedeBriefAction } from '@fleet/foundation-contracts'
import { assignRefusal, createBriefExecutor } from '../src/index.ts'
import { aPeer, aWork, fakeMailbox, fakeReads, fakeStore } from './support/fakes.ts'

const clock = fixedClock('2026-11-10T12:00:00.000Z')
const WORK = 'wrk_7f3a91c2d84b0e56' as WorkId
const PEER = 'engineer-1' as PeerId
const B1 = 'brf_3c4d5e6f708192a3' as BriefId
const B2 = 'brf_4d5e6f708192a3b4' as BriefId
const CONTRACT = 'con_2b3c4d5e6f708192' as ContractId

const assign = (patch: Partial<AssignAction['brief']> = {}): AssignAction => ({
  kind: 'assign',
  causedBy: [4],
  workId: WORK,
  peerId: PEER,
  brief: { briefId: B1, version: 1, contractVersions: [{ contractId: CONTRACT, version: 2 }], text: 'Build the thing.', ...patch },
})

const supersede = (patch: Partial<SupersedeBriefAction> = {}): SupersedeBriefAction => ({
  kind: 'supersede_brief',
  causedBy: [9],
  workId: WORK,
  peerId: PEER,
  supersededBriefId: B1,
  supersededVersion: 1,
  brief: { briefId: B2, version: 2, contractVersions: [{ contractId: CONTRACT, version: 3 }], text: 'Build it on layout v3.' },
  reason: 'contract moved to v3',
  ...patch,
})

const setup = (work = aWork(), peer = aPeer(), mailbox = fakeMailbox()) => {
  const store = fakeStore()
  const executor = createBriefExecutor({ store, reads: fakeReads([work], [peer]), mailbox, clock })
  return { store, mailbox, executor }
}

describe('assign', () => {
  it('publishes the brief, assigns the Work, then sends the brief through the Mailbox', async () => {
    const { store, mailbox, executor } = setup()
    const outcome = await executor.executeAssign(assign())
    assert.equal(outcome.ok, true)
    assert.deepEqual(store.events.map((e) => e.type), ['brief.published', 'work.assigned'])
    assert.deepEqual(mailbox.sent, [
      { to: PEER, from: 'pm', kind: 'brief', briefVersion: 1, body: 'Build the thing.', causedBy: [4] },
    ])
    assert.equal(outcome.seqs.length, 2)
  })

  it('refuses a Work that is not ready, and writes nothing', async () => {
    const { store, mailbox, executor } = setup(aWork({ state: 'needs_contract' }))
    const outcome = await executor.executeAssign(assign())
    assert.equal(outcome.ok, false)
    assert.match(outcome.error ?? '', /not ready/)
    assert.equal(store.events.length, 0)
    assert.equal(mailbox.sent.length, 0)
  })

  it('refuses a version that does not go up', async () => {
    const { store, executor } = setup(aWork(), aPeer({ briefVersion: 1 }))
    const outcome = await executor.executeAssign(assign({ version: 1 }))
    assert.equal(outcome.ok, false)
    assert.match(outcome.error ?? '', /versions only go up/)
    assert.equal(store.events.length, 0)
  })

  it('refuses an unknown Work and an unregistered peer', async () => {
    const store = fakeStore()
    const mailbox = fakeMailbox()
    const none = createBriefExecutor({ store, reads: fakeReads([], [aPeer()]), mailbox, clock })
    assert.match((await none.executeAssign(assign())).error ?? '', /Work does not exist/)
    const noPeer = createBriefExecutor({ store, reads: fakeReads([aWork()], []), mailbox, clock })
    assert.match((await noPeer.executeAssign(assign())).error ?? '', /not registered/)
  })

  it('reports a store failure on the outcome and sends nothing', async () => {
    const { store, mailbox, executor } = setup()
    store.failNext(new Error('disk full'))
    const outcome = await executor.executeAssign(assign())
    assert.equal(outcome.ok, false)
    assert.match(outcome.error ?? '', /disk full/)
    assert.equal(mailbox.sent.length, 0)
  })

  it('a refused send leaves the events written and says a retry is safe; the retry sends once and writes nothing', async () => {
    const mailbox = fakeMailbox()
    mailbox.refuseNext('no session')
    const first = setup(aWork(), aPeer(), mailbox)
    const outcome = await first.executor.executeAssign(assign())
    assert.equal(outcome.ok, false)
    assert.equal(outcome.seqs.length, 2)
    assert.match(outcome.error ?? '', /running the action again is safe/)

    // The store now shows what the events projected: the Work holds the brief, the peer carries v1.
    const retry = setup(aWork({ state: 'assigned', assignee: PEER, briefId: B1, briefVersion: 1 }), aPeer({ briefVersion: 1 }), mailbox)
    const again = await retry.executor.executeAssign(assign())
    assert.equal(again.ok, true)
    assert.equal(retry.store.events.length, 0, 'no second publish')
    assert.equal(mailbox.sent.length, 1, 'the brief is sent exactly once')
  })

  it('does not send a brief the peer already has in its mailbox', async () => {
    const held = {
      msgId: 'msg_0123456789abcdef',
      to: PEER,
      from: 'pm',
      kind: 'brief',
      briefVersion: 1,
      body: 'Build the thing.',
      state: 'delivered',
      sentAt: '2026-11-10T11:00:00.000Z',
    } as unknown as Message
    const { mailbox, executor } = setup(aWork({ state: 'assigned', assignee: PEER, briefId: B1, briefVersion: 1 }), aPeer({ briefVersion: 1 }), fakeMailbox([held]))
    assert.equal((await executor.executeAssign(assign())).ok, true)
    assert.equal(mailbox.sent.length, 0)
  })
})

describe('supersede_brief', () => {
  const current = () => aWork({ state: 'in_progress', assignee: PEER, briefId: B1, briefVersion: 1 })

  it('publishes the replacement, supersedes the old brief, and sends the new one', async () => {
    const { store, mailbox, executor } = setup(current(), aPeer({ briefVersion: 1 }))
    const outcome = await executor.executeSupersede(supersede())
    assert.equal(outcome.ok, true)
    assert.deepEqual(store.events.map((e) => e.type), ['brief.published', 'brief.superseded'])
    const superseded = store.events[1]?.data as { briefId: string; supersededBy: string; version: number }
    assert.deepEqual([superseded.briefId, superseded.supersededBy, superseded.version], [B1, B2, 1])
    assert.equal(mailbox.sent[0]?.briefVersion, 2)
    assert.equal(mailbox.sent[0]?.kind, 'brief')
  })

  it('refuses when the Work moved on from the brief the decision was made against', async () => {
    const moved = aWork({ state: 'in_progress', assignee: PEER, briefId: 'brf_9999999999999999', briefVersion: 5 })
    const { store, executor } = setup(moved, aPeer({ briefVersion: 5 }))
    const outcome = await executor.executeSupersede(supersede())
    assert.equal(outcome.ok, false)
    assert.match(outcome.error ?? '', /inputs moved/)
    assert.equal(store.events.length, 0)
  })

  it('refuses a replacement that is not newer, or for a Work owned by someone else', async () => {
    const stale = setup(current(), aPeer({ briefVersion: 2 }))
    assert.match((await stale.executor.executeSupersede(supersede())).error ?? '', /versions only go up/)
    const other = setup(aWork({ state: 'in_progress', assignee: 'engineer-2', briefId: B1, briefVersion: 1 }), aPeer({ briefVersion: 1 }))
    assert.match((await other.executor.executeSupersede(supersede())).error ?? '', /another peer/)
  })
})

describe('execute', () => {
  it('attempts every action in order, reports failures, and hands other kinds back', async () => {
    const { executor } = setup()
    const request: ExecuteRequest = {
      routineId: 'rtn_1',
      actions: [assign(), { ...assign(), workId: 'wrk_aaaaaaaaaaaaaaaa' as WorkId }, { kind: 'flag_capacity', causedBy: [1] } as never],
    }
    const report = await executor.execute(request)
    assert.equal(report.outcomes.length, 3)
    assert.deepEqual(report.outcomes.map((o) => o.ok), [true, false, false])
    assert.equal(report.executed, 1)
    assert.equal(report.failed, 2)
    assert.match(report.outcomes[2]?.error ?? '', /does not execute 'flag_capacity'/)
    assert.deepEqual(executor.kinds, ['assign', 'supersede_brief'])
  })
})

describe('rules', () => {
  it('treats the Work`s own brief for the same peer as already published, whatever its state', () => {
    const work = aWork({ state: 'in_progress', assignee: PEER, briefId: B1, briefVersion: 1 })
    assert.equal(assignRefusal(assign().brief, PEER, { work, peer: aPeer({ briefVersion: 1 }) }), undefined)
  })
})
