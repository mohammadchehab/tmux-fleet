/**
 * §10, as tests: the gate merges one sha, on a clean review, after moving the
 * dependents it can see, and it never asks for a branch delete while one exists.
 *
 * The port is faked (`fake-github.ts`) and the store is faked (`fake-store.ts`),
 * because that is the whole point of the boundary: §1.1 says `gate` is testable
 * without `gh`, and a real repository here would only re-test git.
 *
 * Each test names the rule it pins; the ones that matter most are about *call
 * order* rather than results — retarget before merge, re-pin after retarget —
 * so the fake keeps a call log and the assertions read it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixedClock, parse } from '@fleet/foundation-core'
import { pmActionFor } from '@fleet/foundation-contracts'
import type { ActionOutcome, MergeAction, RetargetAction, PmAction } from '@fleet/foundation-contracts'
import { createGate } from '../src/gate.ts'
import { fakeGithub, pullRequest, repo, sha } from './support/fake-github.ts'
import { fakeStore } from './support/fake-store.ts'

const at = fixedClock('2026-11-10T10:00:00.000Z')

const merge = (overrides: Partial<MergeAction> = {}): MergeAction =>
  parse(pmActionFor('merge'), {
    kind: 'merge',
    causedBy: [7, 8],
    pr: { repo: repo(), number: 42 },
    headSha: sha(),
    method: 'squash',
    ...overrides,
  }) as MergeAction

const retargetOf = (overrides: Partial<RetargetAction> = {}): RetargetAction =>
  parse(pmActionFor('retarget'), {
    kind: 'retarget',
    causedBy: [7],
    pr: { repo: repo(), number: 42 },
    toBase: 'main',
    ...overrides,
  }) as RetargetAction

const setup = (prs = [pullRequest()], options: { readonly deleteMergedBranches?: boolean } = {}) => {
  const github = fakeGithub(prs)
  const store = fakeStore()
  const gate = createGate({ pullRequests: github, store, clock: at, ...options })
  return { github, store, gate }
}

/** A failed outcome's reason, asserted to exist — the tests read it as the refusal. */
const reason = (outcome: ActionOutcome): string => {
  assert.equal(outcome.ok, false, `expected a refusal, got ${JSON.stringify(outcome.seqs)}`)
  assert.ok(outcome.error !== undefined, 'a refusal carries a sentence')
  return outcome.error
}

describe('a merge the gate allows', () => {
  it('merges the pinned sha, then records it', async () => {
    const { github, store, gate } = setup()

    const outcome = await gate.executeMerge(merge())

    assert.equal(outcome.ok, true)
    assert.deepEqual(
      github.calls.map((call) => call.kind),
      ['get', 'dependents', 'get', 'merge'],
    )
    const merged = store.ofType('pr.merged')
    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.subject, 'backbase/me-services-fleet#42')
    assert.equal(merged[0]?.actor, 'pm')
    assert.deepEqual(merged[0]?.causedBy, [7, 8])
    assert.equal(merged[0]?.data.headSha, sha())
    assert.equal(merged[0]?.data.mergeSha, sha('d36a8b0c1d2e3f405162738495a6b7c8d9e0f102'))
    assert.equal(outcome.seqs.length, 1)
  })

  it('asks for no branch delete: the action cannot ask for one, and nothing should invent it (§5.4, #102)', async () => {
    const { github, gate } = setup()

    await gate.executeMerge(merge())

    const call = github.calls.find((entry) => entry.kind === 'merge')
    assert.equal(call?.kind, 'merge')
    assert.equal(call.kind === 'merge' && call.deleteBranch, false)
  })

  it('hands the pin to the port, so a head that moves mid-merge is refused there too (§10)', async () => {
    const pinned = sha('b2c3d4e5f60718293a4b5c6d7e8f9012345678ab')
    const { github, gate } = setup([pullRequest({ headSha: pinned })])

    await gate.executeMerge(merge({ headSha: pinned }))

    const call = github.calls.find((entry) => entry.kind === 'merge')
    assert.equal(call?.kind === 'merge' && call.headSha, pinned)
  })

  it('deletes the branch only when the profile allows it and nothing sits on the PR', async () => {
    const alone = setup([pullRequest()], { deleteMergedBranches: true })
    await alone.gate.executeMerge(merge())
    const aloneCall = alone.github.calls.find((entry) => entry.kind === 'merge')
    assert.equal(aloneCall?.kind === 'merge' && aloneCall.deleteBranch, true)

    const stacked = setup([pullRequest()], { deleteMergedBranches: true })
    stacked.github.put(pullRequest({ number: 43, base: 'fleet/gate' }))
    stacked.github.stack(42, [43])
    await stacked.gate.executeMerge(merge())
    const stackedCall = stacked.github.calls.find((entry) => entry.kind === 'merge')
    assert.equal(stackedCall?.kind === 'merge' && stackedCall.deleteBranch, false, 'a dependent forbids the delete (#102)')
  })
})

describe('the gate refuses to merge, and says why', () => {
  it('a sha that is no longer the head (match-head-commit)', async () => {
    const { github, store, gate } = setup([pullRequest({ headSha: sha('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') })])

    const refused = reason(await gate.executeMerge(merge()))

    assert.match(refused, /not the a1b2c3d4e5 the checks were green on/)
    assert.equal(github.calls.some((call) => call.kind === 'merge'), false)
    assert.equal(store.ofType('pr.merged').length, 0)
  })

  it('checks that are not green, naming the failing ones', async () => {
    const { gate } = setup([pullRequest({ checks: 'failing', failingChecks: ['lint', 'typecheck'] })])

    const refused = reason(await gate.executeMerge(merge()))

    assert.match(refused, /has failing checks, not passing/)
    assert.match(refused, /lint, typecheck/)
  })

  it('checks still pending, because a pending sha can still move (§10)', async () => {
    const { gate } = setup([pullRequest({ checks: 'pending' })])

    assert.match(reason(await gate.executeMerge(merge())), /has pending checks/)
  })

  it('a review that is not approved', async () => {
    const { gate } = setup([pullRequest({ review: 'pending' })])

    assert.match(reason(await gate.executeMerge(merge())), /is 'pending', not approved/)
  })

  it('a PR a dependent still sits on: merge the parent and retarget first (§10)', async () => {
    const parent = pullRequest({ number: 41, base: 'main', merged: false })
    const { github, gate } = setup([pullRequest({ number: 42, base: 'fleet/parent', stackParent: { repo: repo(), number: 41 } }), parent])

    const refused = reason(await gate.executeMerge(merge()))

    assert.match(refused, /still sits on backbase\/me-services-fleet#41/)
    assert.equal(github.calls.some((call) => call.kind === 'merge'), false)
  })

  it('a PR whose stack parent is merged', async () => {
    const parent = pullRequest({ number: 41, base: 'main', merged: true })
    const { gate } = setup([
      pullRequest({ number: 42, base: 'fleet/parent', stackParent: { repo: repo(), number: 41 } }),
      parent,
    ])

    assert.equal((await gate.executeMerge(merge())).ok, true)
  })

  it('a PR the port does not have, and one already merged', async () => {
    const missing = setup([])
    assert.match(reason(await missing.gate.executeMerge(merge())), /is not a pull request the gate can read/)

    const merged = setup([pullRequest({ merged: true })])
    assert.match(reason(await merged.gate.executeMerge(merge())), /is already merged/)
  })

  it('a port that throws is an outcome, not a throw', async () => {
    const { github, gate } = setup()
    github.failNext('merge', new Error('gh: rate limited'))

    const refused = reason(await gate.executeMerge(merge()))

    assert.match(refused, /rate limited/)
  })
})

describe('a stack is retargeted before its parent merges', () => {
  it('moves every dependent onto the parent base, before the merge is asked for', async () => {
    const { github, store, gate } = setup()
    github.put(pullRequest({ number: 43, base: 'fleet/gate', head: 'fleet/child' }))
    github.stack(42, [43])

    const outcome = await gate.executeMerge(merge())

    assert.equal(outcome.ok, true)
    // The order is the rule: a dependent is moved off this branch before the branch could be merged away.
    assert.deepEqual(
      github.calls.map((call) => call.kind),
      ['get', 'dependents', 'get', 'retarget', 'get', 'merge'],
    )
    const retargeted = store.ofType('pr.retargeted')
    assert.equal(retargeted.length, 1)
    assert.equal(retargeted[0]?.subject, 'backbase/me-services-fleet#43')
    assert.deepEqual(retargeted[0]?.data, {
      pr: { repo: repo(), number: 43 },
      fromBase: 'fleet/gate',
      toBase: 'main',
    })
    // Both events, in the order they happened.
    assert.deepEqual(
      store.events.map((event) => event.type),
      ['pr.retargeted', 'pr.merged'],
    )
    assert.deepEqual(outcome.seqs, [1, 2])
  })

  it('leaves a dependent that is already on the base alone', async () => {
    const { github, store, gate } = setup()
    github.put(pullRequest({ number: 43, base: 'main' }))
    github.stack(42, [43])

    await gate.executeMerge(merge())

    assert.equal(github.calls.some((call) => call.kind === 'retarget'), false)
    assert.equal(store.ofType('pr.retargeted').length, 0)
  })

  it('refuses to merge over a dependent it cannot retarget', async () => {
    const { github, store, gate } = setup()
    github.put(pullRequest({ number: 43, base: 'fleet/gate' }))
    github.stack(42, [43])
    github.failNext('retarget', new Error('protected branch'))

    const refused = reason(await gate.executeMerge(merge()))

    assert.match(refused, /could not be moved onto main/)
    assert.equal(github.calls.some((call) => call.kind === 'merge'), false)
    assert.equal(store.ofType('pr.merged').length, 0)
  })

  it('re-pins after the retarget, and refuses if the head moved while it ran', async () => {
    const { github, store, gate } = setup()
    github.put(pullRequest({ number: 43, base: 'fleet/gate' }))
    github.stack(42, [43])
    // The retarget is a write; the PR that is being merged gets a commit landing while it runs.
    github.onRetarget((number) => {
      if (number === 43) github.put(pullRequest({ headSha: sha('cccccccccccccccccccccccccccccccccccccccc') }))
    })

    const refused = reason(await gate.executeMerge(merge()))

    assert.match(refused, /is at cccccccccc, not the a1b2c3d4e5/)
    assert.equal(github.calls.some((call) => call.kind === 'merge'), false)
    // The move that did happen is still recorded: a retarget is a fact before it is a step of a merge.
    assert.equal(store.ofType('pr.retargeted').length, 1)
    assert.equal(store.ofType('pr.merged').length, 0)
  })

  it('reports a store that refuses the merge event, though the merge already happened', async () => {
    const { store, gate } = setup()
    store.failNext(new Error('disk on fire'))

    const refused = reason(await gate.executeMerge(merge()))

    assert.match(refused, /disk on fire/)
  })
})

describe('a retarget action on its own', () => {
  it('moves the PR and records where it came from', async () => {
    const { github, store, gate } = setup([pullRequest({ base: 'fleet/old' })])

    const outcome = await gate.executeRetarget(retargetOf())

    assert.equal(outcome.ok, true)
    assert.deepEqual(
      github.calls.map((call) => call.kind),
      ['get', 'retarget'],
    )
    const [event] = store.ofType('pr.retargeted')
    assert.deepEqual(event?.data, { pr: { repo: repo(), number: 42 }, fromBase: 'fleet/old', toBase: 'main' })
  })

  it('is a no-op when the PR is already on that base, because the gate retargets dependents itself', async () => {
    const { github, store, gate } = setup([pullRequest({ base: 'main' })])

    const outcome = await gate.executeRetarget(retargetOf())

    assert.equal(outcome.ok, true, 'a repeated retarget is not a failure')
    assert.equal(github.calls.some((call) => call.kind === 'retarget'), false)
    assert.equal(store.events.length, 0)
    assert.deepEqual(outcome.seqs, [])
  })

  it('refuses a merged PR', async () => {
    const { gate } = setup([pullRequest({ merged: true })])

    assert.match(reason(await gate.executeRetarget(retargetOf())), /already merged/)
  })
})

describe('the executor port', () => {
  it('routes merge and retarget, and fails anything else loudly', async () => {
    const { github, store, gate } = setup()
    github.put(pullRequest({ number: 44, base: 'fleet/other' }))
    const flag = parse(pmActionFor('flag_capacity'), {
      kind: 'flag_capacity',
      causedBy: [9],
      peerId: 'engineer-1',
      reason: 'at capacity',
    }) as PmAction

    const report = await gate.execute({
      actions: [
        merge(),
        retargetOf({ pr: { repo: repo(), number: 44 }, toBase: 'main' }),
        flag,
      ],
      routineId: 'rtn_0123456789abcdef',
    })

    assert.equal(report.executed, 2)
    assert.equal(report.failed, 1)
    assert.deepEqual(
      report.outcomes.map((outcome) => outcome.ok),
      [true, true, false],
    )
    assert.match(report.outcomes[2]?.error ?? '', /does not execute 'flag_capacity'/)
    assert.deepEqual(
      store.events.map((event) => event.type),
      ['pr.merged', 'pr.retargeted'],
    )
  })

  it('declares the kinds it carries out', () => {
    const { gate } = setup()
    assert.deepEqual(gate.kinds, ['merge', 'retarget'])
  })

  it('attempts every action even after one fails (§5.2)', async () => {
    const { github, gate } = setup([])
    // The first merge has no PR; the second one does.
    github.put(pullRequest({ number: 45 }))

    const report = await gate.execute({
      actions: [merge(), merge({ pr: { repo: repo(), number: 45 } })],
      routineId: 'rtn_0123456789abcdef',
    })

    assert.deepEqual(
      report.outcomes.map((outcome) => outcome.ok),
      [false, true],
    )
    assert.equal(report.failed, 1)
  })
})
