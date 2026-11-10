/**
 * The deterministic project manager's tick (architecture §5.2, §5.4, §6): the
 * state it reads, the event or heartbeat that asked, and the actions it
 * answers with. A sibling of `judge.ts`, which declares the other thing the PM
 * depends on.
 *
 * Three properties are the reason this is a port in `foundation` and not a
 * class in `orchestration/pm`:
 *
 * - **`decide` is pure and synchronous.** It reads a `FleetState` value, never a
 *   store, and returns actions instead of performing them. A Judge question is
 *   an *action* (§5.3: the PM emits `request_judge` and records the answer), not
 *   a call, so no rule ever awaits a model and `fleet replay --from <seq>` is a
 *   diff rather than a guess (§5.4).
 * - **The state is a snapshot, not a handle.** `FleetState` is the projections
 *   taken as a value, so a tick cannot read twice and see two different fleets,
 *   and a test states the fleet instead of arranging one.
 * - **Actions are data.** `PmAction` (in `actions.ts`) is a closed union with a
 *   schema, so what the PM decided can be recorded, replayed, validated by the
 *   executor and diffed by a test.
 */

import type { Seq, Timestamp } from '@fleet/foundation-core'
import type { PmAction } from './actions.ts'
import type { FleetEvent } from './events/registry.ts'
import type { RoutineKind, RoutineTrigger } from './events/ops.ts'
import type { Message } from './projections/mailbox.ts'
import type { PullRequest, Worktree } from './projections/delivery.ts'
import type { Decision, Finding, JudgeQuestionRecord, Notification, Routine } from './projections/ops.ts'
import type { Peer, Session } from './projections/peers.ts'
import type { Work } from './projections/work.ts'

/**
 * Every projection, as a value (§3). This is `ReadModel` resolved: the same
 * rows, in arrays, with nothing left to await — which is what a pure `decide`
 * can be handed.
 *
 * It is deliberately *not* a schema. A snapshot is an in-process value, never
 * written to the log or sent anywhere, so a strict decode of every projection on
 * every heartbeat would cost more than it proves; the rows it holds are the ones
 * the projections already validated at the write boundary (§3).
 */
export interface FleetState {
  readonly peers: readonly Peer[]
  readonly sessions: readonly Session[]
  readonly work: readonly Work[]
  readonly decisions: readonly Decision[]
  readonly messages: readonly Message[]
  readonly pullRequests: readonly PullRequest[]
  readonly worktrees: readonly Worktree[]
  readonly routines: readonly Routine[]
  readonly findings: readonly Finding[]
  readonly notifications: readonly Notification[]
  /**
   * The typed question log (§5.3), so a rule can read an answer as state. Its
   * absence is what forced `dispatch` to wake on `judge.answered` (§6).
   */
  readonly judge: readonly JudgeQuestionRecord[]
}

/** A `FleetState` with nothing in it: what a first run, and most tests, start from. */
export const emptyFleetState = (): FleetState => ({
  peers: [],
  sessions: [],
  work: [],
  decisions: [],
  messages: [],
  pullRequests: [],
  worktrees: [],
  routines: [],
  findings: [],
  notifications: [],
  judge: [],
})

/**
 * The routine run that asked for the tick. A routine's runs are events (§6), so
 * a tick can always be traced to the run that caused it and to the event, when
 * one, that woke the run.
 */
export interface PmTick {
  /** The instant of the tick, from the scheduler's injected clock (§5.4). */
  readonly at: Timestamp
  readonly routineId: string
  readonly kind: RoutineKind
  readonly trigger: RoutineTrigger
  /** The event that woke the routine, for the heartbeat `undefined`. */
  readonly causedBySeq?: Seq
}

/** §5.2's `decide(state, event)`, with the tick that carries the clock. */
export interface DecideRequest {
  /** The fleet as it stands. A value, so the rules cannot see it move mid-tick. */
  readonly state: FleetState
  /**
   * The event this tick is a response to. Absent on a heartbeat, a cron or a
   * startup run: the fleet's own clock asked, not an event.
   */
  readonly event?: FleetEvent
  /** The run that asked. Always present when a routine decided. */
  readonly tick?: PmTick
}

export interface DecideResult {
  /**
   * What the tick would do, in the order it would do it. Empty is a legitimate
   * outcome and is recorded as such (`routine.finished.actions = 0`, §6).
   *
   * Every action carries `causedBy`: the event seqs the decision was made from,
   * so the executor writes a `decision.answered` that a replay can check (§5.4).
   */
  readonly actions: readonly PmAction[]
  /**
   * A hash of everything the tick read — the state it was given, the event, the
   * clock. Recorded on every `Decision` the actions produce, so a replay that
   * computes a different hash knows the *inputs* changed, not just the rules
   * (§5.4). Eight characters minimum, compared for equality and never parsed.
   */
  readonly inputsHash: string
}

/**
 * One tick of §5.2: state in, actions out, nothing performed. Implemented by
 * `@fleet/orchestration/pm`; faked in every routine test.
 *
 * It is synchronous on purpose. A rule that needed to wait for something would
 * be a rule that cannot be replayed, and the one thing the PM may not decide by
 * rule — a typed question (§5.3) — is an action, not an `await`.
 */
export interface ProjectManager {
  decide(request: DecideRequest): DecideResult
}
