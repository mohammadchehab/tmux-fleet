/**
 * The acceptance test the architect asked for (§5.4): a golden event log, appended through the real store, decides
 * to the same actions every time — and two stores fed the same log agree, down to `inputsHash`.
 *
 * This is the one place `orchestration/pm` touches anything that is not a value, and it does so only in the test:
 * `src/` stays foundation-core + foundation-contracts, while the test opens `@fleet/foundation-store` to prove that
 * `decide` is a function of what the log says and nothing else. A rule that reached for the clock, a store or
 * `randomUUID` would pass every rule test in `decide.test.ts` and fail here.
 *
 * Two things are asserted, in this order:
 *
 * 1. **The action diff.** A fixed log produces a fixed list of actions. The expected list is written out, so a rule
 *    change shows up as a diff a reviewer reads rather than as a count that stayed the same.
 * 2. **The hash.** The same log in a second store produces the same actions *and* the same `inputsHash`. Different
 *    inputs must move the hash; identical inputs must not.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Clock } from '@fleet/foundation-core'
import type {
  ContractId,
  PeerId,
  ProviderSessionRef,
  SessionId,
  WorkId,
  WorktreeId,
} from '@fleet/foundation-core'
import type { AppendEvent, DecideResult } from '@fleet/foundation-contracts'
import { openSqliteStore } from '@fleet/foundation-store'
import type { EventStore } from '@fleet/foundation-store'
import { decide } from '../src/index.ts'
import { kinds } from './support/state.ts'

/** Fixed, so `append` stamps the same `ts` on every run and the log is the only input (§5.4). */
const fixedClock: Clock = {
  now: () => '2026-11-10T12:00:00.000Z',
  millis: () => 1_800_000_000_000,
}

/** A store path under the OS temp dir: the suite never writes into the checkout (CI asserts that). */
const tempStorePath = (): string => join(mkdtempSync(join(tmpdir(), 'fleet-pm-')), 'store.sqlite')

// the log states its ids by hand, so each one is branded here rather than inferred from a literal
const ENGINEER = 'engineer-1' as PeerId
const WORKTREE = 'wtr_5e6f708192a3b4c5' as WorktreeId
const WORK = 'wrk_7f3a91c2d84b0e56' as WorkId
const CONTRACT = 'con_2b3c4d5e6f708192' as ContractId
const SESSION = 'ses_1a2b3c4d5e6f7081' as SessionId
const SESSION_REF = 'ref-1a2b3c4d' as ProviderSessionRef

/** The instant the golden log happens at; the tick reads the same clock, so nothing here depends on today. */
const AT = '2026-11-10T09:00:00.000Z'

/**
 * A log that gives the PM something to do, in the order a real fleet would write it: a peer comes up idle, a Work is
 * proposed and made ready by its contract, the peer takes it, opens a stacked PR, and the gate sees it go green and
 * be approved.
 *
 * `causedBy` is threaded the way `append` would number it, but the seqs are recomputed by the store — the log states
 * causes, not numbers.
 */
const goldenLog = (): readonly AppendEvent[] => [
  {
    ts: AT,
    type: 'peer.registered',
    subject: 'engineer-1',
    actor: 'pm',
    causedBy: [],
    data: {
      peerId: ENGINEER,
      role: 'engineer',
      providerId: 'claude-code',
      model: 'claude-sonnet-5-5',
      permissionMode: 'acceptEdits',
      worktreeId: WORKTREE,
    },
  },
  {
    ts: AT,
    type: 'peer.state_changed',
    subject: 'engineer-1',
    actor: 'scheduler',
    causedBy: [],
    data: { peerId: ENGINEER, state: 'idle', sessionId: SESSION, reason: 'session came up' },
  },
  {
    ts: AT,
    type: 'work.proposed',
    subject: WORK,
    actor: 'user',
    causedBy: [],
    data: {
      workId: WORK,
      title: 'Retarget stacked PRs before merging',
      role: 'engineer',
      body: 'The gate merges a stack parent while a dependent still targets it.',
      dependsOn: [],
    },
  },
  {
    ts: AT,
    type: 'contract.published',
    subject: CONTRACT,
    actor: 'pm',
    causedBy: [],
    data: {
      contractId: CONTRACT,
      version: 2,
      path: 'docs/fleet-v2-architecture.md',
      contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  },
  {
    ts: AT,
    type: 'work.ready',
    subject: WORK,
    actor: 'pm',
    causedBy: [],
    data: { workId: WORK, reason: 'contract v2 published' },
  },
]

/** Open a store at a fresh path, migrate it and append the log: what `apps/daemon` does, minus the daemon. */
const storeWith = async (log: readonly AppendEvent[]): Promise<EventStore> => {
  const store = await openSqliteStore({ path: tempStorePath(), clock: fixedClock })
  await store.migrate()
  await store.append(log)
  return store
}

/** The `FleetState` as the PM is handed it: every projection, read as a value (§5.2). */
const snapshotOf = async (store: EventStore) => {
  const reader = store.reader()
  return {
    peers: await reader.peers.all(),
    sessions: await reader.sessions.all(),
    work: await reader.work.all(),
    decisions: await reader.decisions.all(),
    messages: await reader.messages.all(),
    pullRequests: await reader.pullRequests.all(),
    worktrees: await reader.worktrees.all(),
    routines: await reader.routines.all(),
    findings: await reader.findings.all(),
    notifications: await reader.notifications.all(),
  }
}

/** One tick over a store: a dispatch run at a fixed clock, as the scheduler would ask for it (§6). */
const decideOn = async (store: EventStore): Promise<DecideResult> =>
  decide({
    state: await snapshotOf(store),
    tick: { at: AT, routineId: 'dispatch-1', kind: 'dispatch', trigger: 'schedule' },
  })

test('the golden log decides to the actions it always decided to', async () => {
  const store = await storeWith(goldenLog())
  try {
    const { actions } = await decideOn(store)

    // the log leaves one idle engineer and one ready card, so the tick hands it over — and nothing else
    assert.deepEqual(kinds(actions), ['assign'])
    const assign = actions[0]
    if (assign?.kind !== 'assign') return assert.fail('expected an assign')
    assert.equal(assign.workId, 'wrk_7f3a91c2d84b0e56')
    assert.equal(assign.peerId, 'engineer-1')
    assert.equal(assign.brief.version, 1)
    assert.deepEqual(assign.brief.contractVersions, [])
  } finally {
    await store.close()
  }
})

test('two stores fed the same log decide alike, down to the hash', async () => {
  const first = await storeWith(goldenLog())
  const second = await storeWith(goldenLog())
  try {
    const left = await decideOn(first)
    const right = await decideOn(second)

    assert.deepEqual(right.actions, left.actions)
    assert.equal(right.inputsHash, left.inputsHash)
    assert.match(left.inputsHash, /^[0-9a-f]{16}$/)
  } finally {
    await first.close()
    await second.close()
  }
})

test('the same tick twice on one store is the same tick: decide does not consume anything', async () => {
  const store = await storeWith(goldenLog())
  try {
    const once = await decideOn(store)
    const twice = await decideOn(store)
    assert.deepEqual(twice, once)
  } finally {
    await store.close()
  }
})

test('one more event and the hash moves: the hash is over inputs, not rules', async () => {
  const plain = await storeWith(goldenLog())
  const longer = await storeWith([
    ...goldenLog(),
    {
      ts: AT,
      type: 'session.started',
      subject: SESSION,
      actor: 'scheduler',
      causedBy: [],
      data: {
        sessionId: SESSION,
        peerId: ENGINEER,
        providerId: 'claude-code',
        providerSessionRef: SESSION_REF,
        model: 'claude-sonnet-5-5',
        permissionMode: 'acceptEdits',
        resumed: false,
      },
    },
  ] as readonly AppendEvent[])

  try {
    const before = await decideOn(plain)
    const after = await decideOn(longer)
    assert.notEqual(after.inputsHash, before.inputsHash)
  } finally {
    await plain.close()
    await longer.close()
  }
})
