/**
 * No routine may wake itself (§6, §5.2).
 *
 * `createWakingSink` wakes once per committed event, in seq order, and the
 * scheduler runs every routine whose trigger names that type. So an event a
 * routine's *own* body can append, of a type its own trigger listens for, is a
 * loop: tick → append → wake → tick, bounded only by how long the daemon runs.
 * `causedBy` records the chain for a replay; nothing refuses the re-entry.
 *
 * There is one way out, and the fleet uses it: a body may append through the
 * **raw store** instead of the waking sink. Then its events are facts written
 * down, not wake-ups, and a trigger that names them is safe. `notify`,
 * `security-scan` and `pr-babysit` are built that way in `compose.ts`;
 * `pr-babysit` is the load-bearing case — it appends `pr.opened`,
 * `pr.checks_changed`, `pr.review_changed` and `pr.merged`, and wakes on all four.
 *
 * So the invariant, for every routine body the build ships: **if a body appends
 * through the waking sink, the event types it can append and the event types its
 * trigger listens for are disjoint.**
 *
 * **The emission sets are declared here, not derived.** A tick body's emissions
 * are whatever its `PmAction`s cause, and causing them takes the real executors
 * and their ports; a body's own appends are one or two `store.append` calls. So
 * each row names the file its emission set summarises, and the covering test
 * makes a body without a row a failure — the table is where a new emission has
 * to be written down before it can be forgotten.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { eventTypes, type FleetEventType, type RoutineKind } from '@fleet/foundation-contracts'
import { defaultTriggers, installedFactories } from '@fleet/orchestration-routines'

/**
 * What one PM tick can append, whichever rule decided it — the union over
 * `pmActionKinds` (§5.2). All four `runTick` bodies can decide any of them, so
 * they share this set; a body that stops being a plain tick narrows its own row.
 *
 * The source of each: `assign` and `supersede_brief` publish a brief
 * (`packages/orchestration/briefs/src/executor.ts`); `send_message` hands over
 * through the Mailbox (`packages/runtime/mailbox/src/mailbox.ts`);
 * `request_judge` is two events (`packages/orchestration/judge/src/judge.ts`);
 * `merge` and `retarget` are the gate's (`packages/orchestration/gate/src/gate.ts`);
 * the rest are `apps/daemon/src/executors.ts`. `flag_capacity` appends nothing:
 * §5.2 calls it a capacity fact, already in the log as `peer.state_changed`.
 */
const tickEmits: readonly FleetEventType[] = [
  'brief.published',
  'work.assigned',
  'brief.superseded',
  'message.sent',
  'message.delivered',
  'judge.requested',
  'judge.answered',
  'decision.requested',
  'pr.merged',
  'pr.retargeted',
  'standup.rendered',
]

interface BodyEmissions {
  /** Every event type the body can append. */
  readonly types: readonly FleetEventType[]
  /**
   * Whether those appends reach `createWakingSink`. A tick body's appends do:
   * its actions are executed over the wiring's waking `append`. A body given the
   * raw store in `compose.ts` (the `notify` and `security-scan` factories) does
   * not, and is then free to append what its own trigger names.
   */
  readonly wakes: boolean
}

/** The body of each routine this build can run, and what running it can append. */
const bodyEmits: Readonly<Partial<Record<RoutineKind, BodyEmissions>>> = {
  // A plain PM tick: src/routines/{dispatch,keep-busy,reconcile,standup}.ts.
  dispatch: { types: tickEmits, wakes: true },
  'keep-busy': { types: tickEmits, wakes: true },
  reconcile: { types: tickEmits, wakes: true },
  standup: { types: tickEmits, wakes: true },
  // §6.2: the findings planner appends a finding, or states the absence.
  'security-scan': { types: ['finding.raised', 'finding.seen', 'scan.skipped'], wakes: false },
  // §6.1: the ledger records what the channel did.
  notify: { types: ['notify.sent', 'notify.failed', 'notify.withdrawn'], wakes: false },
  // §6's third row: the poll writes down what the forge said. This is the body
  // whose every append is a type its own trigger names, so it only holds because
  // `compose.ts` hands it the raw store.
  'pr-babysit': {
    types: ['pr.opened', 'pr.checks_changed', 'pr.review_changed', 'pr.merged'],
    wakes: false,
  },
}

/** The types a routine's trigger is woken by; a schedule, a heartbeat or a start wakes nothing by type. */
const wakesOn = (kind: RoutineKind): readonly FleetEventType[] => {
  const triggers = defaultTriggers[kind]
  return triggers.flatMap((trigger) => (trigger.kind === 'event' ? trigger.types : []))
}

const overlap = (a: readonly string[], b: readonly string[]): readonly string[] => a.filter((type) => b.includes(type))

test('no routine is woken by an event its own body appends (§6)', () => {
  for (const [kind, body] of Object.entries(bodyEmits) as [RoutineKind, BodyEmissions][]) {
    if (!body.wakes) continue
    const triggers = wakesOn(kind)
    assert.deepEqual(
      overlap(triggers, body.types),
      [],
      `${kind} wakes on ${triggers.join(', ')} and appends ${body.types.join(', ')} through the waking sink: a run would re-enter itself`,
    )
  }
})

/**
 * The table above is only a guard if no body can exist without a row in it. The
 * four phase 1 bodies are `installedFactories`; `notify`, `security-scan` and
 * `pr-babysit` are factories `compose.ts` adds, because they need a channel, a
 * tool set or a forge the routines package may not know (§1.1). A further such
 * body is added to this list in the same change that adds its row.
 */
test('every routine body this build ships has an emission set (§6)', () => {
  const bodies = [...Object.keys(installedFactories), 'notify', 'security-scan', 'pr-babysit'].sort()
  assert.deepEqual(
    Object.keys(bodyEmits).sort(),
    bodies,
    'a body with no row here is a routine whose self-wake nothing checks',
  )
})

/** A misspelt type would pass the disjointness check by never matching anything. */
test('every declared emission is a registered event type (§3)', () => {
  for (const [kind, body] of Object.entries(bodyEmits) as [RoutineKind, BodyEmissions][]) {
    for (const type of body.types) {
      assert.ok((eventTypes as readonly string[]).includes(type), `${kind} claims to append "${type}", which is not registered`)
    }
  }
})
