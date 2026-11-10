/**
 * Publishing this fleet's pace and reading the others' (shared-fleet.md §2.2,
 * §3, §9), against an in-memory `Coordination` with the port's lease rules.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FleetError } from '@fleet/foundation-core'
import { FLEET_PACE_FILE } from '@fleet/foundation-contracts'
import { createPacePublisher, encodePace, fleetPaceOf, HEARTBEAT_MS, readFleetPaces } from '../src/index.ts'
import { fakeCoordination, fakeRead, manualClock, peerRow } from './support/fakes.ts'

const REF = 'eng-07/fleet/alice'
const START = '2026-11-16T00:00:00.000Z'

const setup = (spentUsd = 150) => {
  const coordination = fakeCoordination()
  const { clock, advance } = manualClock(START)
  const { read, state } = fakeRead({ spentUsd, peers: [peerRow('engineer-1', 'engineer', 'idle')] })
  const publisher = () => createPacePublisher({ coordination, read, ref: REF, capUsd: 300, clock })
  return { coordination, clock, advance, state, publisher }
}

const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(promise, (thrown: unknown) => thrown instanceof FleetError && thrown.code === code)
}

describe('publishing a pace', () => {
  it('pushes the first tick, and pushes exactly the pace and nothing derived from the work (§9)', async () => {
    const { coordination, state, publisher } = setup()
    state.peers = [peerRow('engineer-1', 'engineer', 'idle'), peerRow('wrk-owner', 'engineer', 'working')]

    const tick = await publisher().tick()

    assert.equal(tick.published, true)
    assert.deepEqual(Object.keys(coordination.pushes[0]!.files), [FLEET_PACE_FILE])
    const bytes = coordination.pushes[0]!.files[FLEET_PACE_FILE]!
    assert.deepEqual(Object.keys(JSON.parse(bytes)), [
      'version',
      'month',
      'capUsd',
      'spentUsd',
      'unpricedTurns',
      'pace',
      'capacity',
      'heartbeat',
    ])
    assert.ok(!bytes.includes('engineer-1') && !bytes.includes('wrk-owner'), 'roles are counted; no peer is named')
    assert.equal(tick.pace.pace, 1)
  })

  it('does not push again while the facts are the same and the heartbeat is fresh', async () => {
    const { coordination, advance, publisher } = setup()
    const p = publisher()
    await p.tick()
    advance(HEARTBEAT_MS - 1)

    assert.equal((await p.tick()).published, false)
    assert.equal(coordination.pushes.length, 1)
  })

  it('pushes as soon as a fact changes', async () => {
    const { coordination, state, advance, publisher } = setup()
    const p = publisher()
    await p.tick()
    advance(30_000)
    state.spentUsd = 152

    assert.equal((await p.tick()).published, true)
    assert.equal(coordination.pushes.length, 2)
  })

  it('pushes a heartbeat when nothing changed for ten minutes', async () => {
    const { coordination, advance, publisher } = setup()
    const p = publisher()
    await p.tick()
    advance(HEARTBEAT_MS)

    assert.equal((await p.tick()).published, true)
    assert.equal(coordination.pushes.length, 2)
  })

  it('picks up its own branch after a restart instead of reading it as someone else', async () => {
    const { coordination, advance, publisher } = setup()
    await publisher().tick()
    advance(60_000)

    const restarted = publisher()
    assert.equal((await restarted.tick()).published, false, 'the branch it finds is its own, and still fresh')
    advance(HEARTBEAT_MS)
    assert.equal((await restarted.tick()).published, true, 'and its lease is on the sha it found')
    assert.equal(coordination.pushes.length, 2)
  })

  it('refuses to overwrite a branch another machine wrote, and re-reads it on the next tick', async () => {
    const { coordination, clock, advance, state, publisher } = setup()
    const p = publisher()
    await p.tick()
    const other = fleetPaceOf({
      capUsd: 300,
      spend: { month: '2026-11', costUsd: 10, turns: 1, unpricedTurns: 0 },
      peers: [],
      at: clock.now(),
    })
    coordination.force(REF, { [FLEET_PACE_FILE]: encodePace(other) })
    state.spentUsd = 160

    await rejectsWith(p.tick(), 'conflict')
    assert.equal(coordination.pushes.length, 1, 'the other machine’s write stands')

    advance(1_000)
    assert.equal((await p.tick()).published, true)
  })

  it('does not start without a cap', () => {
    const { coordination, clock } = setup()
    assert.throws(
      () => createPacePublisher({ coordination, read: fakeRead().read, ref: REF, capUsd: 0, clock }),
      (e: unknown) => e instanceof FleetError && e.code === 'invalid_input',
    )
  })
})

describe('reading the other fleets', () => {
  it('reads every other fleet in the engagement, and not itself, another engagement or a non-fleet ref', async () => {
    const { coordination, clock } = setup()
    const doc = (spent: number) =>
      encodePace(
        fleetPaceOf({ capUsd: 300, spend: { month: '2026-11', costUsd: spent, turns: 1, unpricedTurns: 0 }, peers: [], at: clock.now() }),
      )
    coordination.force('eng-07/fleet/bob', { [FLEET_PACE_FILE]: doc(30) })
    coordination.force('eng-07/fleet/alice', { [FLEET_PACE_FILE]: doc(150) })
    coordination.force('eng-08/fleet/carol', { [FLEET_PACE_FILE]: doc(30) })
    coordination.force('eng-07/claim/7f3a9c', { by: 'bob' })
    coordination.force('eng-07/fleet/dave/extra', { [FLEET_PACE_FILE]: doc(30) })

    const fleets = await readFleetPaces({ coordination, namespace: 'eng-07', self: 'alice', clock })

    assert.deepEqual(
      fleets.map((fleet) => ('pace' in fleet ? [fleet.user, fleet.pace.pace, fleet.offline] : [fleet.user, fleet.problem])),
      [['bob', 0.2, false]],
    )
  })

  it('reads a fleet whose heartbeat is half an hour old as offline', async () => {
    const { coordination, clock, advance } = setup()
    await createPacePublisher({ coordination, read: fakeRead({ spentUsd: 10 }).read, ref: 'eng-07/fleet/bob', capUsd: 300, clock }).tick()
    advance(30 * 60_000 + 1)

    const [bob] = await readFleetPaces({ coordination, namespace: 'eng-07', self: 'alice', clock })
    assert.ok(bob !== undefined && 'pace' in bob && bob.offline)
  })

  it('reports a fleet it cannot read, and still reads the rest', async () => {
    const { coordination, clock } = setup()
    const good = encodePace(
      fleetPaceOf({ capUsd: 300, spend: { month: '2026-11', costUsd: 30, turns: 1, unpricedTurns: 0 }, peers: [], at: clock.now() }),
    )
    coordination.force('eng-07/fleet/bob', { [FLEET_PACE_FILE]: good })
    coordination.force('eng-07/fleet/carol', { [FLEET_PACE_FILE]: '{not json' })
    coordination.force('eng-07/fleet/dave', { [FLEET_PACE_FILE]: JSON.stringify({ ...JSON.parse(good), pace: -1 }) })
    coordination.force('eng-07/fleet/erin', { [FLEET_PACE_FILE]: JSON.stringify({ ...JSON.parse(good), taskIds: ['PROJ-412'] }) })
    coordination.force('eng-07/fleet/frank', { 'other.json': '{}' })

    const fleets = await readFleetPaces({ coordination, namespace: 'eng-07', self: 'alice', clock })

    assert.deepEqual(
      fleets.map((fleet) => [fleet.user, 'pace' in fleet]),
      [
        ['bob', true],
        ['carol', false],
        ['dave', false],
        ['erin', false],
        ['frank', false],
      ],
    )
  })
})
