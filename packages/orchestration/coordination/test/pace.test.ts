/**
 * The pace arithmetic (shared-fleet.md §3): what share of the month has gone,
 * how fast the cap is being spent against it, and who is idle.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FleetError } from '@fleet/foundation-core'
import { capacityOf, elapsedShare, fleetPaceOf, monthOf, paceOf, sameFacts } from '../src/index.ts'
import { peerRow } from './support/fakes.ts'

describe('the month', () => {
  it('is the UTC month, whatever offset the instant was written in', () => {
    assert.equal(monthOf('2026-11-01T01:00:00.000+02:00'), '2026-10')
    assert.equal(monthOf('2026-11-30T23:59:59.000Z'), '2026-11')
  })

  it('has gone by the share of its own length, so February is not measured as a 31-day month', () => {
    assert.equal(elapsedShare('2026-11-16T00:00:00.000Z'), 0.5)
    assert.equal(elapsedShare('2026-02-15T00:00:00.000Z'), 0.5)
    assert.equal(elapsedShare('2026-11-01T00:00:00.000Z'), 0)
  })
})

describe('pace', () => {
  const mid = '2026-11-16T00:00:00.000Z'

  it('is 1 when the cap is being spent exactly as fast as the month passes', () => {
    assert.equal(paceOf({ capUsd: 300, spentUsd: 150, at: mid }), 1)
  })

  it('is below 1 under pace and above it over', () => {
    assert.equal(paceOf({ capUsd: 300, spentUsd: 75, at: mid }), 0.5)
    assert.equal(paceOf({ capUsd: 300, spentUsd: 225, at: mid }), 1.5)
    assert.equal(paceOf({ capUsd: 300, spentUsd: 0, at: mid }), 0)
  })

  it('is far over, not infinite, for a turn in the first minute of a month', () => {
    // 1/300 of the cap in at most an hour of a 720-hour month.
    assert.equal(paceOf({ capUsd: 300, spentUsd: 1, at: '2026-11-01T00:00:30.000Z' }), 2.4)
  })

  it('does not exist without a cap', () => {
    assert.throws(() => paceOf({ capUsd: 0, spentUsd: 0, at: mid }), (e: unknown) => e instanceof FleetError && e.code === 'invalid_input')
  })
})

describe('capacity', () => {
  it('counts idle peers by role, and nobody who is working, waiting or gone', () => {
    const peers = [
      peerRow('engineer-2', 'engineer', 'idle'),
      peerRow('architect', 'architect', 'idle'),
      peerRow('engineer-1', 'engineer', 'idle'),
      peerRow('engineer-3', 'engineer', 'working'),
      peerRow('security', 'security', 'waiting_input'),
      peerRow('designer', 'designer', 'ended'),
    ]

    assert.deepEqual(capacityOf(peers), [
      { role: 'architect', idle: 1 },
      { role: 'engineer', idle: 2 },
    ])
  })
})

describe('a pace document', () => {
  const at = '2026-11-16T00:00:00.000Z' as const
  const doc = (spent: number, minutesLater = 0) =>
    fleetPaceOf({
      capUsd: 300,
      spend: { month: '2026-11', costUsd: spent, turns: 1, unpricedTurns: 0 },
      peers: [peerRow('engineer-1', 'engineer', 'idle')],
      at: new Date(Date.parse(at) + minutesLater * 60_000).toISOString() as typeof at,
    })

  it('carries spend to the cent', () => {
    assert.equal(doc(150.004).spentUsd, 150)
  })

  it('has the same facts when only the clock moved, and different ones when the spend did', () => {
    assert.ok(sameFacts(doc(150), doc(150.001, 30)), 'pace and heartbeat drift with time alone')
    assert.ok(!sameFacts(doc(150), doc(151)))
  })
})
