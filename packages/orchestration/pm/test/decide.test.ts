/**
 * The rule table (architecture §5.2, §5.4, §10), one rule at a time.
 *
 * Each test states a fleet and asks what the tick would do with it. The assertions are on the actions — the data the
 * executor would carry out — because that is what the PM is: nothing here opens a store, waits, or reads the clock.
 * Where a rule is a *refusal*, the test names the blocker instead of proving a negative from an empty list, so the
 * reason a merge did not happen is asserted and not assumed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  approvalDecisionId,
  blockedDecisionId,
  decide,
  indexOf,
  mergeBlocker,
  resolveOptions,
  similarity,
} from '../src/index.ts'
import type { RuleContext } from '../src/index.ts'
import type { DecideRequest, FleetEvent, FleetState, PmAction, PullRequest } from '@fleet/foundation-contracts'
import type { QuestionId } from '@fleet/foundation-core'
import {
  architect,
  decision,
  kinds,
  message,
  notification,
  peer,
  pullRequest,
  refOf,
  state,
  tick,
  tokenReport,
  work,
  T0,
} from './support/state.ts'

/** A log line, as the store would hand it back: the envelope the PM may narrow on. */
const event = (type: string, subject: string, data: unknown, seq = 41): FleetEvent =>
  ({ seq, ts: T0, type, subject, actor: 'pm', causedBy: [seq - 1], data }) as unknown as FleetEvent

const contractKey = (): string => 'con_2b3c4d5e6f708192'

/** The id the `work()` builder gives: the Work every unblock test is stuck on. */
const snapshotWorkId = () => work().workId

/** A `RuleContext` for the rules a test calls directly, carrying the same defaults `decide` resolves. */
const context = (snapshot: FleetState): RuleContext => ({
  state: snapshot,
  index: indexOf(snapshot),
  options: resolveOptions({}),
  causedBy: [],
  questioned: new Set<string>(),
})

// --------------------------------------------------------------------- assign

test('a held or stopped peer is given no Work, and no idle nudge (watch-and-attach §4, §7.2)', () => {
  for (const parked of ['held', 'stopped'] as const) {
    const { actions } = decide({
      state: state({
        peers: [peer({ peerId: 'engineer-1' as never, state: parked })],
        work: [work({ title: 'Ship the store', role: 'engineer', body: 'Make the append-only store pass its tests.' })],
      }),
      tick: tick(),
    })
    assert.ok(!kinds(actions).includes('assign'), `${parked}: no assign`)
    assert.ok(!actions.some((action) => 'peerId' in action && action.peerId === 'engineer-1'), `${parked}: nothing aimed at it`)
  }
})

test('a peer takes the next ready Work for its role, with a v1 brief', () => {
  const request: DecideRequest = {
    state: state({
      peers: [peer({ peerId: 'engineer-1' as never })],
      work: [work({ title: 'Ship the store', role: 'engineer', body: 'Make the append-only store pass its tests.' })],
    }),
    tick: tick(),
  }

  const { actions, inputsHash } = decide(request)
  assert.deepEqual(kinds(actions), ['assign'])
  const assign = actions[0]
  assert.equal(assign?.kind, 'assign')
  if (assign?.kind !== 'assign') return
  assert.equal(assign.workId, 'wrk_0000000000000001')
  assert.equal(assign.peerId, 'engineer-1')
  assert.equal(assign.brief.version, 1)
  assert.match(String(assign.brief.briefId), /^brf_[0-9a-f]{16}$/)
  assert.match(assign.brief.text, /Ship the store/)
  assert.deepEqual(assign.brief.contractVersions, [])
  // a heartbeat cites nothing: no event asked for this
  assert.deepEqual(assign.causedBy, [])
  assert.match(inputsHash, /^[0-9a-f]{16}$/)
})

test('a brief goes above the version the peer already carries, or the executor refuses it as not newer (§12.1)', () => {
  // A peer's version is one counter: a standing brief (`peer.standards_set`) or an
  // earlier Work's brief has already moved it, and a v1 here would be refused.
  for (const carried of [1, 4]) {
    const request: DecideRequest = {
      state: state({
        peers: [peer({ peerId: 'engineer-1' as never, briefVersion: carried })],
        work: [work({ title: 'Ship the store', role: 'engineer', body: 'Make the append-only store pass its tests.' })],
      }),
      tick: tick(),
    }
    const assign = decide(request).actions[0]
    if (assign?.kind !== 'assign') return assert.fail('expected an assign')
    assert.equal(assign.brief.version, carried + 1)
  }
})

test('a re-assigned Work still goes above the peer’s version when the Work’s own is higher', () => {
  const request: DecideRequest = {
    state: state({
      peers: [peer({ peerId: 'engineer-1' as never, briefVersion: 2 })],
      work: [work({ title: 'Ship the store', role: 'engineer', body: 'x', briefVersion: 5 })],
    }),
    tick: tick(),
  }
  const assign = decide(request).actions[0]
  if (assign?.kind !== 'assign') return assert.fail('expected an assign')
  assert.equal(assign.brief.version, 6)
})

test('a brief names the contract version the published event carries, and no other', () => {
  // the snapshot has no Contract projection, so the version comes from the event that made the Work ready (§12)
  const contractId = contractKey()
  const request: DecideRequest = {
    state: state({
      peers: [peer()],
      work: [work({ role: 'engineer', contractId: contractId as never })],
    }),
    event: event('contract.published', contractId, {
      contractId,
      version: 3,
      path: 'docs/contracts/store.md',
      contentHash: 'c'.repeat(64),
    }),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['assign'])
  const assign = actions[0]
  if (assign?.kind !== 'assign') return assert.fail('expected an assign')
  assert.deepEqual(assign.brief.contractVersions, [{ contractId, version: 3 }])
  assert.deepEqual(assign.causedBy, [41])
})

test('Work for another role is left for a peer who has it', () => {
  const request: DecideRequest = {
    state: state({ peers: [peer({ role: 'engineer' })], work: [work({ role: 'designer' })] }),
    tick: tick(),
  }
  const { actions } = decide(request)
  assert.ok(!kinds(actions).includes('assign'), 'no engineer may take a designer card')
})

test('a peer at the PR cap is not handed another Work', () => {
  const busy = pullRequest({ number: 1, workId: 'wrk_0000000000000009' })
  const alsoBusy = pullRequest({ number: 2, workId: 'wrk_0000000000000009' })
  const request: DecideRequest = {
    state: state({
      peers: [peer()],
      work: [
        work({ workId: 'wrk_0000000000000009' as never, state: 'in_review', assignee: 'engineer-1' as never, prs: [refOf(busy), refOf(alsoBusy)] }),
        work({ workId: 'wrk_0000000000000002' as never, role: 'engineer' }),
      ],
      pullRequests: [busy, alsoBusy],
    }),
    tick: tick(),
  }

  const { actions } = decide(request)
  assert.ok(!kinds(actions).includes('assign'), 'two open PRs is §5.2 s cap')
})

test('two ready Works and one idle peer: one is handed out, not both', () => {
  const request: DecideRequest = {
    state: state({
      peers: [peer()],
      work: [
        work({ workId: 'wrk_0000000000000001' as never, role: 'engineer' }),
        work({ workId: 'wrk_0000000000000002' as never, role: 'engineer', title: 'Something else entirely' }),
      ],
    }),
    tick: tick(),
  }

  const { actions } = decide(request)
  assert.equal(actions.filter((action) => action.kind === 'assign').length, 1)
})

// ------------------------------------------------------------ supersede (stale)

test('a contract leaves the peer on it stale: the brief is superseded, never edited', () => {
  const contractId = contractKey()
  const request: DecideRequest = {
    state: state({
      peers: [peer()],
      work: [
        work({
          state: 'in_progress',
          assignee: 'engineer-1' as never,
          contractId: contractId as never,
          briefId: 'brf_1111111111111111' as never,
          briefVersion: 1,
        }),
      ],
    }),
    event: event('contract.published', contractId, {
      contractId,
      version: 2,
      path: 'docs/contracts/store.md',
      contentHash: 'd'.repeat(64),
    }),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['supersede_brief'])
  const supersede = actions[0]
  if (supersede?.kind !== 'supersede_brief') return assert.fail('expected a supersede')
  assert.equal(supersede.supersededBriefId, 'brf_1111111111111111')
  assert.equal(supersede.supersededVersion, 1)
  assert.equal(supersede.brief.version, 2)
  assert.deepEqual(supersede.brief.contractVersions, [{ contractId, version: 2 }])
  assert.equal(supersede.reason, `contract ${contractId} published v2`)
  assert.deepEqual(supersede.causedBy, [41])
})

test('a Work that waits on the contract is superseded too, through dependsOn', () => {
  const contractId = contractKey()
  const request: DecideRequest = {
    state: state({
      peers: [peer()],
      work: [
        work({
          state: 'in_progress',
          assignee: 'engineer-1' as never,
          dependsOn: [contractId],
          briefId: 'brf_2222222222222222' as never,
          briefVersion: 4,
        }),
      ],
    }),
    event: event('contract.published', contractId, {
      contractId,
      version: 1,
      path: 'docs/contracts/store.md',
      contentHash: 'e'.repeat(64),
    }),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['supersede_brief'])
  assert.equal(actions[0]?.kind === 'supersede_brief' && actions[0].supersededVersion, 4)
})

test('a heartbeat supersedes nothing: staleness is read from the event, not guessed', () => {
  const request: DecideRequest = {
    state: state({
      peers: [peer()],
      work: [
        work({
          state: 'in_progress',
          assignee: 'engineer-1' as never,
          contractId: contractKey() as never,
          briefId: 'brf_1111111111111111' as never,
          briefVersion: 1,
        }),
      ],
    }),
    tick: tick(),
  }
  assert.deepEqual(kinds(decide(request).actions), [])
})

// ----------------------------------------------------------------------- merge

test('green and approved: the gate is asked to merge, at the SHA it saw green', () => {
  const pr = pullRequest()
  const request: DecideRequest = {
    state: state({ peers: [architect()], pullRequests: [pr] }),
    event: event('pr.checks_changed', 'backbase/fleet#38', {
      pr: refOf(pr),
      headSha: pr.headSha,
      state: 'passing',
      failing: [],
    }),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['merge'])
  const merge = actions[0]
  if (merge?.kind !== 'merge') return assert.fail('expected a merge')
  assert.equal(merge.headSha, pr.headSha)
  assert.equal(merge.method, 'squash')
  // §10: a merge action cannot express `--delete-branch`, so it cannot get it wrong
  assert.ok(!('deleteBranch' in merge))
})

test('the gate refuses a merge and names why', () => {
  // §10's preconditions are refusals, so the test names the reason rather than proving a negative from an empty list
  const refusals: readonly (readonly [PullRequest, string])[] = [
    [pullRequest({ merged: true }), 'already merged'],
    [pullRequest({ checks: 'failing', failingChecks: ['build'] }), 'checks are failing'],
    [pullRequest({ checks: 'pending' }), 'checks are pending'],
    [pullRequest({ review: 'changes_requested' }), 'review is changes_requested'],
    [pullRequest({ review: 'pending' }), 'review is pending'],
  ]

  for (const [pr, reason] of refusals) {
    const snapshot = state({ peers: [architect()], pullRequests: [pr] })
    assert.equal(mergeBlocker(pr, context(snapshot)), reason)
    assert.ok(!kinds(decide({ state: snapshot, tick: tick() }).actions).includes('merge'), reason)
  }
})

test('an unmerged stack parent blocks the dependent', () => {
  const parent = pullRequest({ number: 12, base: 'main', head: 'feature/contract', merged: false })
  const dependent = pullRequest({
    number: 13,
    base: 'feature/contract',
    head: 'feature/store',
    stackParent: refOf(parent),
  })
  const request: DecideRequest = {
    state: state({ peers: [architect()], pullRequests: [parent, dependent] }),
    tick: tick(),
  }

  const { actions } = decide(request)
  // the parent itself merges; the dependent waits for it
  assert.deepEqual(
    actions.filter((action) => action.kind === 'merge').map((action) => action.kind === 'merge' && action.pr.number),
    [12],
  )
})

test('a merged stack parent: the dependent is retargeted first, and not merged in the same tick', () => {
  const parent = pullRequest({ number: 12, base: 'main', head: 'feature/contract', merged: true })
  const dependent = pullRequest({
    number: 13,
    base: 'feature/contract',
    head: 'feature/store',
    stackParent: refOf(parent),
  })
  const request: DecideRequest = {
    state: state({ peers: [architect()], pullRequests: [parent, dependent] }),
    tick: tick(),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['retarget'])
  const retarget = actions[0]
  if (retarget?.kind !== 'retarget') return assert.fail('expected a retarget')
  assert.equal(retarget.pr.number, 13)
  assert.equal(retarget.toBase, 'main')
})

test('a dependent already moved onto the parent base is merged', () => {
  const parent = pullRequest({ number: 12, base: 'main', head: 'feature/contract', merged: true })
  const dependent = pullRequest({ number: 13, base: 'main', head: 'feature/store', stackParent: refOf(parent) })
  const request: DecideRequest = {
    state: state({ peers: [architect()], pullRequests: [parent, dependent] }),
    tick: tick(),
  }

  const merged = decide(request).actions.filter((action) => action.kind === 'merge')
  assert.deepEqual(merged.map((action) => action.kind === 'merge' && action.pr.number), [13])
})

// ----------------------------------------------------------------------- judge

test('a ready Work that repeats an open one is asked about, and neither is handed out', () => {
  const twin = work({
    workId: 'wrk_0000000000000001' as never,
    title: 'Add an append-only event store with projections',
    createdAt: T0,
  })
  const duplicate = work({
    workId: 'wrk_0000000000000002' as never,
    title: 'Add an append-only event store with projections',
    createdAt: '2026-11-10T09:30:00.000Z',
  })
  const request: DecideRequest = {
    state: state({ peers: [peer()], work: [twin, duplicate] }),
    tick: tick(),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['request_judge'])
  const question = actions[0]
  if (question?.kind !== 'request_judge') return assert.fail('expected a judge question')
  assert.equal(question.question, 'same_feature')
  assert.match(String(question.questionId), /^qst_[0-9a-f]{16}$/)
  assert.equal(question.workId, duplicate.workId)
  assert.ok(similarity(twin, duplicate) >= 0.6)
  if (question.input.kind !== 'same_feature') return assert.fail('wrong input kind')
  assert.equal(question.input.a.title, duplicate.title)
  assert.equal(question.input.b.title, twin.title)
})

test('a proposed card with no goal is a thin card', () => {
  const request: DecideRequest = {
    state: state({ peers: [peer()], work: [work({ state: 'proposed', title: 'Do the store', body: 'soon' })] }),
    tick: tick(),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['request_judge'])
  const question = actions[0]
  if (question?.kind !== 'request_judge') return assert.fail('expected a judge question')
  assert.equal(question.question, 'thin_card')
  if (question.input.kind !== 'thin_card') return assert.fail('wrong input kind')
  assert.deepEqual(question.input.acceptance, [])
})

test('a card the Judge found not thin becomes ready, read from the question rather than its answer event', () => {
  const card = work({ state: 'proposed', title: 'Do the store', body: 'soon' })

  // Ask first: the id the rule derives is the one the question is recorded under.
  const asking = decide({ state: state({ peers: [peer()], work: [card] }), tick: tick() })
  const asked = asking.actions[0]
  if (asked?.kind !== 'request_judge') return assert.fail('expected the card to be questioned')

  const answered = decide({
    state: state({
      peers: [peer()],
      work: [card],
      judge: [
        {
          questionId: asked.questionId,
          kind: 'thin_card',
          inputsHash: 'sha256:4c1d7e9a0b2f3568',
          workId: card.workId,
          askedAt: T0,
          answer: { kind: 'thin_card', thin: false, missing: [], why: 'The card names its goal.' },
          model: 'claude-haiku-4-5',
          answeredAt: T0,
        },
      ],
    }),
    tick: tick(),
  })

  const ready = answered.actions.find((action) => action.kind === 'mark_ready')
  if (ready?.kind !== 'mark_ready') return assert.fail('expected the answered card to become ready')
  assert.equal(ready.workId, card.workId)
  assert.match(ready.reason ?? '', /found no missing goal/)
})

test('a card the Judge called thin stays proposed', () => {
  const card = work({ state: 'proposed', title: 'Do the store', body: 'soon' })
  const asking = decide({ state: state({ peers: [peer()], work: [card] }), tick: tick() })
  const asked = asking.actions[0]
  if (asked?.kind !== 'request_judge') return assert.fail('expected the card to be questioned')

  const answered = decide({
    state: state({
      peers: [peer()],
      work: [card],
      judge: [
        {
          questionId: asked.questionId,
          kind: 'thin_card',
          inputsHash: 'sha256:4c1d7e9a0b2f3568',
          workId: card.workId,
          askedAt: T0,
          answer: { kind: 'thin_card', thin: true, missing: ['a goal'], why: 'The body is one line.' },
          model: 'claude-haiku-4-5',
          answeredAt: T0,
        },
      ],
    }),
    tick: tick(),
  })

  // A thin card is re-asked on every tick, and that is the question rules' own business
  // (`questionThinCards` derives the same `questionId`, so a repeat collapses in the
  // executor). What must not happen is a promotion: a thin verdict is an answer, not a
  // flavour of yes.
  assert.ok(!kinds(answered.actions).includes('mark_ready'), 'a thin verdict is an answer, not a flavour of yes')
})

test('an escalated Judge answer becomes the user s decision, carrying its question', () => {
  // The answer is stated as a *row on the question*, and the tick is given no
  // `judge.answered` event at all: reading it from the projection is what lets a
  // heartbeat ask this, not only the tick that saw the answer arrive (§5.3, §6).
  const request: DecideRequest = {
    state: state({
      peers: [peer()],
      judge: [
        {
          questionId: 'qst_0000000000000001' as QuestionId,
          kind: 'escalate',
          inputsHash: 'sha256:0000000000000001',
          askedAt: T0,
          answer: {
            kind: 'escalate',
            escalate: true,
            question: 'Two stores are in play. Which one is the source of truth?',
            options: ['sqlite', 'json'],
            why: 'the card names both',
          },
          model: 'claude-haiku-4-5',
          answeredAt: T0,
        },
      ],
    }),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['request_decision'])
  const asked = actions[0]
  if (asked?.kind !== 'request_decision') return assert.fail('expected a decision')
  assert.equal(asked.decisionKind, 'escalate')
  assert.equal(asked.question, 'Two stores are in play. Which one is the source of truth?')
  assert.deepEqual(asked.options, ['sqlite', 'json'])
})

// ------------------------------------------------------------------- decisions

test('green checks with review pending and no reviewer running: the gate asks the user', () => {
  const pr = pullRequest({ review: 'pending' })
  const request: DecideRequest = { state: state({ peers: [peer()], pullRequests: [pr] }), tick: tick() }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['request_decision'])
  const asked = actions[0]
  if (asked?.kind !== 'request_decision') return assert.fail('expected a decision')
  assert.equal(asked.decisionKind, 'approval')
  assert.deepEqual(asked.options, ['merge', 'hold'])
  assert.equal(asked.decisionId, approvalDecisionId(refOf(pr), pr.headSha))
  assert.match(asked.question, /backbase\/fleet#38/)
})

test('with a live pr-architect the approval is not asked', () => {
  const pr = pullRequest({ review: 'pending' })
  const request: DecideRequest = { state: state({ peers: [architect()], pullRequests: [pr] }), tick: tick() }
  assert.deepEqual(kinds(decide(request).actions), [])
})

test('a dead reviewer does not count as running', () => {
  const pr = pullRequest({ review: 'pending' })
  const request: DecideRequest = {
    state: state({ peers: [architect({ state: 'failed' })], pullRequests: [pr] }),
    tick: tick(),
  }
  assert.deepEqual(kinds(decide(request).actions), ['request_decision'])
})

test('the user s merge answer lets the gate merge without a reviewer', () => {
  const pr = pullRequest({ review: 'pending' })
  const answered = decision({
    decisionId: approvalDecisionId(refOf(pr), pr.headSha),
    state: 'answered',
    option: 'merge',
  })
  const request: DecideRequest = {
    state: state({ peers: [peer()], pullRequests: [pr], decisions: [answered] }),
    tick: tick(),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['merge'])
})

test('a ready Work whose role nobody holds is put to the user', () => {
  const request: DecideRequest = {
    state: state({ peers: [peer({ role: 'engineer' })], work: [work({ role: 'designer' })] }),
    tick: tick(),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['request_decision'])
  const asked = actions[0]
  if (asked?.kind !== 'request_decision') return assert.fail('expected a decision')
  assert.equal(asked.decisionKind, 'no_peer')
  assert.match(asked.question, /designer/)
})

test('a question already in the inbox is not opened twice', () => {
  const pr = pullRequest({ review: 'pending' })
  const open = decision({ decisionId: approvalDecisionId(refOf(pr), pr.headSha), state: 'open' })
  const request: DecideRequest = {
    state: state({ peers: [peer()], pullRequests: [pr], decisions: [open] }),
    tick: tick(),
  }
  assert.deepEqual(kinds(decide(request).actions), [])
})

// ------------------------------------------------------------------------ idle

test('an idle peer with nothing ready is flagged, and the dry spell is raised once', () => {
  const request: DecideRequest = {
    state: state({ peers: [peer({ updatedAt: '2026-11-10T08:30:00.000Z' })] }),
    tick: tick({ at: '2026-11-10T09:00:00.000Z' }),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['flag_capacity', 'raise_no_work'])
  const raised = actions[1]
  if (raised?.kind !== 'raise_no_work') return assert.fail('expected no_work')
  assert.equal(raised.role, 'engineer')
  assert.match(raised.reason, /1 peer idle past 10 minutes/)
})

test('a peer inside the threshold is not spare capacity yet', () => {
  const request: DecideRequest = {
    state: state({ peers: [peer({ updatedAt: '2026-11-10T08:58:00.000Z' })] }),
    tick: tick({ at: '2026-11-10T09:00:00.000Z' }),
  }
  assert.deepEqual(kinds(decide(request).actions), [])
})

test('no tick, no clock: the idle rule says nothing', () => {
  const request: DecideRequest = { state: state({ peers: [peer({ updatedAt: '2026-11-01T00:00:00.000Z' })] }) }
  assert.deepEqual(kinds(decide(request).actions), [])
})

// -------------------------------------------------------------------- standup

test('the standup routine renders today s report', () => {
  const request: DecideRequest = {
    state: state({ peers: [peer()] }),
    tick: tick({ kind: 'standup', trigger: 'schedule', routineId: 'standup-1', at: '2026-11-10T09:00:00.000Z' }),
  }

  const { actions } = decide(request)
  assert.deepEqual(kinds(actions), ['render_standup'])
  assert.equal(actions[0]?.kind === 'render_standup' && actions[0].date, '2026-11-10')
})

test('a standup already rendered today is not rendered twice', () => {
  const request: DecideRequest = {
    state: state({ notifications: [notification({ key: 'standup:2026-11-10' as never })] }),
    tick: tick({ kind: 'standup', trigger: 'schedule', at: '2026-11-10T17:00:00.000Z' }),
  }
  assert.deepEqual(kinds(decide(request).actions), [])
})

test('the dispatch routine never renders a standup', () => {
  const request: DecideRequest = { state: state(), tick: tick({ at: '2026-11-10T09:00:00.000Z' }) }
  assert.deepEqual(kinds(decide(request).actions), [])
})

// --------------------------------------------------------------------- replay

test('the same request decides the same way twice, down to the hash', () => {
  const request: DecideRequest = {
    state: state({
      peers: [peer(), architect()],
      work: [work({ role: 'engineer' }), work({ workId: 'wrk_0000000000000002' as never, state: 'proposed' })],
      pullRequests: [pullRequest({ review: 'pending' })],
    }),
    tick: tick({ at: '2026-11-10T09:00:00.000Z' }),
  }

  const first = decide(request)
  const second = decide(request)
  assert.deepEqual(second.actions, first.actions)
  assert.equal(second.inputsHash, first.inputsHash)
})

test('the hash is over the inputs: a different clock or a different fleet is a different hash', () => {
  const base: DecideRequest = { state: state({ peers: [peer()] }), tick: tick() }
  const later: DecideRequest = { ...base, tick: tick({ at: '2026-11-10T10:00:00.000Z' }) }
  const more: DecideRequest = { ...base, state: state({ peers: [peer(), architect()] }) }

  assert.equal(decide(base).inputsHash, decide({ ...base }).inputsHash)
  assert.notEqual(decide(base).inputsHash, decide(later).inputsHash)
  assert.notEqual(decide(base).inputsHash, decide(more).inputsHash)
})

test('a reordered snapshot hashes alike: a store s answer order is not an input', () => {
  const left = state({ peers: [peer({ peerId: 'a' as never }), peer({ peerId: 'b' as never })] })
  const right = state({ peers: [peer({ peerId: 'b' as never }), peer({ peerId: 'a' as never })] })
  const request = (snapshot: typeof left): DecideRequest => ({ state: snapshot, tick: tick() })

  assert.equal(decide(request(left)).inputsHash, decide(request(right)).inputsHash)
})

// -------------------------------------------------------------------- unblock
// §5.2 `unblock`: a peer in `waiting_input` is stuck on a blocked Work, and `Work.blockedOn` says who
// can clear it. The tests walk the three routes in the order the rule tries them, plus the two that
// would otherwise re-fire on every heartbeat.

/** An engineer waiting on its own blocked Work: the trigger every case below starts from. */
const stuck = (over: { blockedOn?: 'user' | 'contract' | 'peer' | 'external'; blockedReason?: string } = {}) => ({
  peers: [peer({ state: 'waiting_input' })],
  work: [
    work({
      state: 'blocked',
      assignee: 'engineer-1' as never,
      blockedReason: over.blockedReason ?? 'which price source is authoritative?',
      ...(over.blockedOn === undefined ? {} : { blockedOn: over.blockedOn }),
    }),
  ],
})

/** The one action of a kind, failing the test when the tick produced none. */
const only = <K extends PmAction['kind']>(actions: readonly PmAction[], kind: K): Extract<PmAction, { kind: K }> => {
  const found = actions.filter((action): action is Extract<PmAction, { kind: K }> => action.kind === kind)
  const [one, ...rest] = found
  assert.ok(one !== undefined && rest.length === 0, `expected exactly one ${kind}, got ${kinds(actions).join(', ') || 'nothing'}`)
  return one
}

test('a block only the user can clear becomes one decision in the inbox, naming the peer and why', () => {
  const snapshot = state(stuck({ blockedOn: 'user' }))
  const actions = decide({ state: snapshot, tick: tick() }).actions

  const asked = only(actions, 'request_decision')
  assert.equal(asked.decisionKind, 'blocked')
  assert.equal(asked.decisionId, blockedDecisionId(snapshot.work[0]!))
  assert.equal(asked.workId, snapshot.work[0]!.workId)
  assert.deepEqual(asked.options, [], 'a blockage is answered in words, not from a list of two')
  assert.match(asked.question, /engineer-1 \(engineer\) is waiting/)
  assert.match(asked.question, /which price source is authoritative\?/)
  // §5.2: the PM routes, it does not message the user
  assert.ok(!kinds(actions).includes('send_message'))
})

test('the same blockage is not asked about twice: the inbox row is the question', () => {
  const snapshot = state(stuck({ blockedOn: 'user' }))
  const first = only(decide({ state: snapshot, tick: tick() }).actions, 'request_decision')

  const answered = state({
    ...stuck({ blockedOn: 'user' }),
    decisions: [decision({ decisionId: first.decisionId, kind: 'blocked', workId: first.workId })],
  })
  assert.deepEqual(decide({ state: answered, tick: tick() }).actions, [], 'an open row is already the question')
})

test('a peer block is routed to the reviewer role as a message, with the reason and the brief to answer against', () => {
  const snapshot = state({ ...stuck({ blockedOn: 'peer' }), peers: [peer({ state: 'waiting_input' }), architect()] })
  const actions = decide({ state: snapshot, tick: tick() }).actions

  const sent = only(actions, 'send_message')
  assert.equal(sent.to, 'architect-1')
  assert.equal(sent.messageKind, 'info')
  assert.equal(sent.briefVersion, 0, "the architect's own brief version, not the waiting peer's")
  assert.match(sent.body, /engineer-1/)
  assert.match(sent.body, /Blocked on peer/)
  assert.ok(!kinds(actions).includes('request_decision'), 'a role that can answer means the user is not asked')
})

test('a peer block nobody can route does not go silent: it falls back to the user', () => {
  const actions = decide({ state: state(stuck({ blockedOn: 'contract' })), tick: tick() }).actions
  const asked = only(actions, 'request_decision')

  assert.equal(asked.decisionKind, 'blocked')
  assert.match(asked.question, /No live peer holds the "pr-architect" role/)
})

test('an answer already in the Decision log is delivered, and the user is asked nothing', () => {
  const snapshot = state({
    ...stuck({ blockedOn: 'user' }),
    decisions: [
      decision({
        decisionId: 'dec_6f708192a3b4c5d6' as never,
        kind: 'blocked',
        state: 'answered',
        text: 'Use the slow source; it is the only one with history.',
        workId: snapshotWorkId(),
        answeredAt: '2026-11-10T10:00:00.000Z',
      }),
    ],
  })
  const actions = decide({ state: snapshot, tick: tick() }).actions

  const sent = only(actions, 'send_message')
  assert.equal(sent.to, 'engineer-1')
  assert.equal(sent.messageKind, 'answer')
  assert.match(sent.body, /Use the slow source/)
  assert.match(sent.body, /dec_6f708192a3b4c5d6/, 'the peer can cite which decision it is acting on')
  assert.ok(!kinds(actions).includes('request_decision'), 'it is answered: asking again would be a loop')
})

test('a delivered answer is not re-sent on the next heartbeat', () => {
  const workId = snapshotWorkId()
  const snapshot = state({
    ...stuck({ blockedOn: 'user' }),
    decisions: [
      decision({
        decisionId: 'dec_6f708192a3b4c5d6' as never,
        kind: 'blocked',
        state: 'answered',
        text: 'Use the slow source.',
        workId,
        answeredAt: T0,
      }),
    ],
    messages: [message({ to: peer().peerId, body: 'This answers dec_6f708192a3b4c5d6 ("which source?")' })],
  })
  assert.deepEqual(decide({ state: snapshot, tick: tick() }).actions, [])
})

test('a routed peer block is not re-sent either', () => {
  const workId = snapshotWorkId()
  const snapshot = state({
    ...stuck({ blockedOn: 'peer' }),
    peers: [peer({ state: 'waiting_input' }), architect()],
    messages: [message({ to: architect().peerId, body: `engineer-1 is waiting on Work ${workId}: Ship the store` })],
  })
  assert.deepEqual(decide({ state: snapshot, tick: tick() }).actions, [])
})

test('a waiting peer with no blocked Work is the provider s business, not the PM s', () => {
  // a peer mid-turn asking its own question: there is no Work field to route by, so nothing is invented
  const snapshot = state({
    peers: [peer({ state: 'waiting_input' })],
    work: [work({ state: 'in_progress', assignee: 'engineer-1' as never })],
  })
  assert.deepEqual(decide({ state: snapshot, tick: tick() }).actions, [])
})

// -------------------------------------------------------------- the brief (§3)

test('a Work that came from a board gives the peer the ticket key and where to open it', () => {
  const request: DecideRequest = {
    state: state({
      peers: [peer({ peerId: 'engineer-1' as never })],
      work: [
        work({
          role: 'engineer',
          external: { system: 'backlog', key: 'TASK-12', url: 'https://github.com/acme/widgets/blob/main/backlog/tasks/task-12.md' },
        }),
      ],
    }),
    tick: tick(),
  }

  const assign = decide(request).actions[0]
  assert.equal(assign?.kind, 'assign')
  if (assign?.kind !== 'assign') return
  assert.match(
    assign.brief.text,
    /Ticket: backlog TASK-12 — https:\/\/github\.com\/acme\/widgets\/blob\/main\/backlog\/tasks\/task-12\.md/,
  )
})

test('a ticket with no url is named by system and key alone, with no dangling dash', () => {
  const request: DecideRequest = {
    state: state({
      peers: [peer({ peerId: 'engineer-1' as never })],
      work: [work({ role: 'engineer', external: { system: 'backlog', key: 'TASK-12' } })],
    }),
    tick: tick(),
  }

  const assign = decide(request).actions[0]
  assert.equal(assign?.kind, 'assign')
  if (assign?.kind !== 'assign') return
  assert.match(assign.brief.text, /^Ticket: backlog TASK-12$/m)
})

test('a Work with no ticket says nothing about one', () => {
  const request: DecideRequest = {
    state: state({
      peers: [peer({ peerId: 'engineer-1' as never })],
      work: [work({ role: 'engineer' })],
    }),
    tick: tick(),
  }

  const assign = decide(request).actions[0]
  assert.equal(assign?.kind, 'assign')
  if (assign?.kind !== 'assign') return
  assert.doesNotMatch(assign.brief.text, /Ticket:/)
})

// ------------------------------------------------------------------ blocked notes
// §5.1: a peer's `work.noted` with phase `blocked` is the peer saying it cannot go on. `plan`,
// `implement` and `mr` are progress and the PM does nothing with them; `blocked` raises the same
// inbox row `work.blocked` would, because it is the same question about the same Work.

/** An engineer working its own Work, and the note it just wrote. */
const noted = (over: { phase?: string; body?: string; workId?: string } = {}) => ({
  snapshot: state({
    peers: [peer({ peerId: 'engineer-1' as never, state: 'working' })],
    work: [work({ state: 'in_progress', assignee: 'engineer-1' as never })],
  }),
  note: event('work.noted', 'wrk_0000000000000001', {
    workId: over.workId ?? 'wrk_0000000000000001',
    peerId: 'engineer-1',
    phase: over.phase ?? 'blocked',
    body: over.body ?? 'the store has no way to replay a partial log',
  }),
})

test('a blocked note becomes one question in the inbox, naming the peer and the words it used', () => {
  const { snapshot, note } = noted()
  const actions = decide({ state: snapshot, tick: tick(), event: note }).actions

  const asked = only(actions, 'request_decision')
  assert.equal(asked.decisionKind, 'blocked')
  assert.equal(asked.decisionId, blockedDecisionId(snapshot.work[0]!), 'the same row `work.blocked` would raise')
  assert.equal(asked.workId, snapshot.work[0]!.workId)
  assert.deepEqual(asked.options, [])
  assert.match(asked.question, /engineer-1 says it is blocked/)
  assert.match(asked.question, /no way to replay a partial log/)
  assert.deepEqual(asked.causedBy, [note.seq], 'the question cites the note that asked it')
})

test('a progress note is mirrored to the board and asks the user nothing', () => {
  for (const phase of ['plan', 'implement', 'mr']) {
    const { snapshot, note } = noted({ phase })
    assert.deepEqual(decide({ state: snapshot, tick: tick(), event: note }).actions, [], `${phase} moves nothing`)
  }
})

test('a blocked note does not open a second row for a Work the user already has a question about', () => {
  const { snapshot, note } = noted()
  const asked = only(decide({ state: snapshot, tick: tick(), event: note }).actions, 'request_decision')
  const answered = state({
    peers: snapshot.peers,
    work: snapshot.work,
    decisions: [decision({ decisionId: asked.decisionId, kind: 'blocked', workId: asked.workId })],
  })

  assert.deepEqual(decide({ state: answered, tick: tick(), event: note }).actions, [])
})

test('a heartbeat has no note to read, so a blocked note never asks twice from the clock alone', () => {
  const { snapshot } = noted()
  assert.deepEqual(decide({ state: snapshot, tick: tick() }).actions, [])
})

test('a note about a Work the fleet does not have is left in the log rather than guessed at', () => {
  const { snapshot, note } = noted({ workId: 'wrk_00000000000000ff' })
  assert.deepEqual(decide({ state: snapshot, tick: tick(), event: note }).actions, [])
})

// -------------------------------------------------------------- the ledger the rules read (TASK-72)
// `inputsHash` claims to cover everything the rules could have read. The spend cap reads `tokens` and the judge rules
// read `judge`, so a state that differs only there must hash differently: a replay over a different bill is not a
// replay of this one, and a cap decided on a stale bill must not be recognised as current.

test('the hash covers the ledger: a different bill is a different input', () => {
  const base = state({ peers: [peer()] })
  const bill = (costUsd: number) => state({ peers: [peer()], tokens: [tokenReport({ costUsd })] })

  assert.notEqual(decide({ state: base, tick: tick() }).inputsHash, decide({ state: bill(3), tick: tick() }).inputsHash)
  assert.notEqual(decide({ state: bill(3), tick: tick() }).inputsHash, decide({ state: bill(4), tick: tick() }).inputsHash)
})

test('the hash covers the judge questions: a question answered since is a different input', () => {
  const question = {
    questionId: 'jq_0000000000000001' as never,
    kind: 'judge' as never,
    inputsHash: 'abcdef0123456789',
    askedAt: '2026-11-10T09:00:00.000Z',
  }
  const open = state({ peers: [peer()], judge: [question] })
  const answered = state({
    peers: [peer()],
    judge: [{ ...question, answer: 'merge', answeredAt: '2026-11-10T09:05:00.000Z', model: 'opus' } as never],
  })

  assert.notEqual(decide({ state: open, tick: tick() }).inputsHash, decide({ state: answered, tick: tick() }).inputsHash)
})

test('the ledger hashes alike in any order: a store s answer order is not an input (TASK-72)', () => {
  const a = tokenReport({ peerId: 'a' as never, costUsd: 1 })
  const b = tokenReport({ peerId: 'b' as never, costUsd: 2 })
  const left = state({ peers: [peer()], tokens: [a, b] })
  const right = state({ peers: [peer()], tokens: [b, a] })

  assert.equal(decide({ state: left, tick: tick() }).inputsHash, decide({ state: right, tick: tick() }).inputsHash)
})
