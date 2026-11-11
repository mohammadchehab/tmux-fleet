/**
 * The soft spend cap (TASK-12 PR2, architecture §6.1 with §6.2's cost report).
 *
 * The cap is a rule, not a routine: when the fleet's bill crosses the profile's budget the PM appends
 * `decision.requested` and §6.1's inbox projects it, so the user is reached through the one channel the spec allows and
 * a replay re-derives the question from the same ledger.
 *
 * The bill is `FleetState.tokens`: §6.2 writes a rollup row per peer with no `workId`, and the per-Work rows are that
 * row's breakdown — so summing every row would bill a Work twice. Most tests here are about which rows count.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { budgetDecisionId, decide } from '../src/index.ts'
import type { DecideRequest, PmAction, TokenReport } from '@fleet/foundation-contracts'
import type { WorkId } from '@fleet/foundation-core'
import { decision, kinds, peer, state, tick, tokenReport } from './support/state.ts'

/** A fleet whose only interesting property is its bill: one live peer, and these ledger rows. */
const request = (tokens: readonly TokenReport[], decisions: DecideRequest['state']['decisions'] = []): DecideRequest => ({
  state: state({ peers: [peer()], tokens, decisions }),
  tick: tick(),
})

const only = (actions: readonly PmAction[]): Extract<PmAction, { kind: 'request_decision' }> => {
  const asked = actions.filter((action) => action.kind === 'request_decision')
  assert.equal(asked.length, 1, `expected exactly one requested decision, got ${String(asked.length)}`)
  const first = asked[0]
  if (first?.kind !== 'request_decision') throw new Error('expected a request_decision')
  return first
}

const asks = (req: DecideRequest, budgetUsd: number | undefined): boolean =>
  kinds(decide(req, budgetUsd === undefined ? {} : { budgetUsd }).actions).includes('request_decision')

/** A rollup row: a peer's whole bill, the row the fleet's spend is the sum of. */
const rollup = (costUsd: number, over: Partial<TokenReport> = {}): TokenReport => tokenReport({ costUsd, ...over })

test('a fleet inside its budget is asked nothing', () => {
  assert.equal(asks(request([rollup(3)]), 10), false)
})

test('a fleet with no budget configured is never asked', () => {
  assert.equal(asks(request([rollup(1_000_000)]), undefined), false)
})

test('crossing the budget asks the user, through the decision inbox', () => {
  const asked = only(decide(request([rollup(12)]), { budgetUsd: 10 }).actions)

  assert.equal(asked.decisionKind, 'budget')
  assert.deepEqual(asked.options, ['continue', 'raise budget'])
  assert.equal(asked.decisionId, budgetDecisionId(10))
  assert.match(asked.question, /\$12\.00/)
  assert.match(asked.question, /\$10\.00/)
})

test('the budget is crossed at the number, not after it', () => {
  assert.equal(asks(request([rollup(10)]), 10), true)
})

test("per-Work rows are the rollup's breakdown, never billed on top of it", () => {
  // 6 + 6 = 12 would cross a 10 budget; 6 does not. Summing every row would ask twice about the same money.
  const rows = [rollup(6), tokenReport({ workId: 'wrk_0000000000000001' as WorkId, costUsd: 6 })]
  assert.equal(asks(request(rows), 10), false)
})

test('a turn that reported no price makes the total a floor, and the question says so', () => {
  // cursor reports turns with no cost (§6.2): the number is real but it is not the whole bill.
  const rows = [rollup(12), rollup(0, { peerId: 'engineer-2' as TokenReport['peerId'], turns: 4 })]
  const asked = only(decide(request(rows), { budgetUsd: 10 }).actions)

  assert.match(asked.question, /at least \$12\.00/)
  assert.match(asked.question, /no price/)
})

test('an open question is not asked again on the next tick', () => {
  const open = decision({ decisionId: budgetDecisionId(10), state: 'open', kind: 'budget' })
  assert.equal(asks(request([rollup(12)], [open]), 10), false)
})

test('an answered question is not asked again: the answer is the user saying continue', () => {
  const answered = decision({ decisionId: budgetDecisionId(10), state: 'answered', kind: 'budget' })
  assert.equal(asks(request([rollup(12)], [answered]), 10), false)
})

test('a raised budget is a different question, so it is asked again when the spend is still over it', () => {
  const answered = decision({ decisionId: budgetDecisionId(10), state: 'answered', kind: 'budget' })
  const req = request([rollup(25)], [answered])

  const asked = only(decide(req, { budgetUsd: 20 }).actions)
  assert.equal(asked.decisionId, budgetDecisionId(20))
  assert.match(asked.question, /\$20\.00/)
})

test('a cap raised above the spend stops the question: that is what the answer bought', () => {
  const answered = decision({ decisionId: budgetDecisionId(10), state: 'answered', kind: 'budget' })
  assert.equal(asks(request([rollup(12)], [answered]), 50), false)
})
