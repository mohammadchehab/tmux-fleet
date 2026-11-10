/**
 * The executors the daemon owns (§5.2). `orchestration/gate` carries `merge`
 * and `retarget` and `orchestration/briefs` carries `assign` and
 * `supersede_brief`; everything else the PM may decide is performed here,
 * because performing it means holding a Mailbox, a Judge or the projections,
 * and this is the only place those exist (§2).
 *
 * One executor per thing being acted on, not one per kind: the Mailbox, the
 * Judge, the decision inbox, the standup renderer and the capacity fact are five
 * different dependencies, and a single executor holding all of them would be a
 * second composition root. The router only cares that each kind has exactly one
 * home (`executor.ts`), which this wiring keeps true by construction.
 *
 * Two outcomes are legitimate successes with no events, and both say so rather
 * than looking like a missed append:
 *
 * - `flag_capacity` writes nothing. §5.2 calls it "a capacity fact, not a state
 *   change": a peer's state comes from its provider (§4), so the free capacity
 *   is already in the log as that peer's `peer.state_changed`. Writing a second
 *   event for it would make a second source of truth for one fact.
 * - `raise_no_work` is raised **once per dry spell** (§5.2), and the spell lasts
 *   as long as the question is open, so an already-open one is not repeated.
 */

import { createHash } from 'node:crypto'
import { newDecisionId, systemClock, toFleetError, type Clock, type Seq } from '@fleet/foundation-core'
import type {
  ActionExecutor,
  ActionOutcome,
  AppendEvent,
  EventSink,
  ExecuteRequest,
  ExecutionReport,
  FlagCapacityAction,
  Mailbox,
  MessageAckState,
  PmAction,
  PmActionKind,
  RaiseNoWorkAction,
  ReadModel,
  RenderStandupAction,
  RequestDecisionAction,
  RequestJudgeAction,
  SendMessageAction,
} from '@fleet/foundation-contracts'
import type { JudgeService } from '@fleet/orchestration-judge'
import type { KindExecutor } from './executor.ts'
import { renderStandup } from './standup.ts'

/** The states a message is still waiting to be acted on in, for the standup's pending count (§7). */
const unacked: readonly MessageAckState[] = ['pending', 'delivered']

/**
 * The decision kind a dry spell is recorded as. A role-specific spell gets its
 * own kind (`no_work:engineer`) rather than a parsed question, so "have I said
 * this already?" is one exact comparison and survives the question being
 * reworded (§5.2).
 */
export const NO_WORK_KIND = 'no_work'

const kindForNoWork = (role: string | undefined): string =>
  role === undefined ? NO_WORK_KIND : `${NO_WORK_KIND}:${role}`

/** The hash the decision records its inputs with, for replay (§5.4). */
const hashOf = (...parts: readonly string[]): string =>
  `sha256:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`

/** An executor that also says which kinds it carries out; what the router is wired with. */
export interface Executor extends ActionExecutor {
  readonly kinds: readonly PmActionKind[]
}

const done = (action: PmAction, seqs: readonly Seq[]): ActionOutcome => ({ action, ok: true, seqs })
const failed = (action: PmAction, error: string): ActionOutcome => ({ action, ok: false, seqs: [], error })

/**
 * Append what an action caused, or say why it could not. A store that refuses
 * the events is a failure of the action and not a detail to log and forget: the
 * events *are* the record (§3).
 */
const append = async (
  store: EventSink,
  events: readonly AppendEvent[],
): Promise<{ readonly seqs: readonly Seq[] } | { readonly error: string }> => {
  if (events.length === 0) return { seqs: [] }
  try {
    return { seqs: await store.append(events) }
  } catch (thrown) {
    return { error: toFleetError(thrown, 'store_failed').message }
  }
}

/**
 * Run one action at a time, reporting each. Shared by every executor here: the
 * router calls an executor with a single action, so this is the shape that
 * keeps an unexpected kind a visible `failed` outcome rather than a throw that
 * would lose the rest of the tick (§5.2).
 */
const executor = (
  kinds: readonly PmActionKind[],
  one: (action: PmAction) => Promise<ActionOutcome>,
): Executor => ({
  kinds,
  async execute(request: ExecuteRequest): Promise<ExecutionReport> {
    const outcomes: ActionOutcome[] = []
    for (const action of request.actions) {
      outcomes.push(
        kinds.includes(action.kind)
          ? await one(action)
          : failed(action, `this executor does not carry out '${action.kind}'; the daemon routes it elsewhere`),
      )
    }
    return {
      outcomes,
      executed: outcomes.filter((outcome) => outcome.ok).length,
      failed: outcomes.filter((outcome) => !outcome.ok).length,
    }
  },
})

// ------------------------------------------------------------------ §7 send

export interface MailboxExecutorDeps {
  readonly mailbox: Mailbox
}

/**
 * `send_message`: one §7 message, then delivered.
 *
 * The delivery is attempted in the same action because the PM decided to reach
 * the peer *now* — a nudge that waits for the supervisor's next tick is a nudge
 * that arrives after the thing it was about. A delivery that fails is a failed
 * action: the message is still in the box (at-least-once, §7) and is retried,
 * but the routine's `actionsFailed` is where a peer nobody can reach shows up.
 */
export const createMailboxExecutor = (deps: MailboxExecutorDeps): Executor =>
  executor(['send_message'], async (action) => {
    const send = action as SendMessageAction
    let msgId
    try {
      const sent = await deps.mailbox.send({
        to: send.to,
        from: 'pm',
        kind: send.messageKind,
        briefVersion: send.briefVersion,
        body: send.body,
        causedBy: send.causedBy,
      })
      if (!sent.ok) return failed(action, `${sent.error.code}: ${sent.error.message}`)
      msgId = sent.value
    } catch (thrown) {
      return failed(action, toFleetError(thrown, 'store_failed').message)
    }

    try {
      const delivered = await deps.mailbox.deliver(send.to)
      if (!delivered.ok) return failed(action, `${delivered.error.code}: ${delivered.error.message}`)
      const refusal = delivered.value.failures.find((failure) => failure.msgId === msgId)
      if (refusal !== undefined) {
        return failed(action, `the message was not delivered (${refusal.reason}); it stays pending in the box`)
      }
    } catch (thrown) {
      return failed(action, toFleetError(thrown, 'provider_failed').message)
    }

    // The Mailbox owns both appends and returns the message id, not their seqs;
    // the events are in the log and cite this action's `causedBy`.
    return done(action, [])
  })

// ---------------------------------------------------------- §5.3 the Judge

export interface JudgeExecutorDeps {
  readonly judge: JudgeService
  readonly store: EventSink
  readonly clock?: Clock
}

/**
 * `request_judge`: ask the one typed question, and record what came back.
 *
 * A model that cannot produce a valid answer after its retry is **not** a
 * failed action — the fleet did what it could and learned something. §5.3 says
 * that case becomes an escalation to the user, never a guess, so it appends the
 * `decision.requested` that puts it in the inbox. The alternative, leaving it
 * as `actionsFailed`, would drop the question on the floor.
 */
export const createJudgeExecutor = (deps: JudgeExecutorDeps): Executor => {
  const clock = deps.clock ?? systemClock

  const escalate = async (action: RequestJudgeAction, reason: string): Promise<ActionOutcome> => {
    const decisionId = newDecisionId()
    const written = await append(deps.store, [
      {
        type: 'decision.requested',
        ts: clock.now(),
        subject: action.workId ?? decisionId,
        actor: 'pm',
        causedBy: action.causedBy,
        data: {
          decisionId,
          kind: 'escalate',
          question: `The judge could not answer the ${action.question} question: ${reason}`.slice(0, 2000),
          options: [],
          ...(action.workId === undefined ? {} : { workId: action.workId }),
          inputsHash: action.inputsHash,
          routedTo: 'user',
        },
      } as AppendEvent,
    ])
    if ('error' in written) return failed(action, written.error)
    return done(action, written.seqs)
  }

  return executor(['request_judge'], async (action) => {
    const ask = action as RequestJudgeAction
    const asked = await deps.judge.ask({
      questionId: ask.questionId,
      kind: ask.question,
      input: ask.input,
      inputsHash: ask.inputsHash,
      ...(ask.workId === undefined ? {} : { workId: ask.workId }),
      ...(ask.askedFor === undefined ? {} : { askedFor: ask.askedFor }),
    })
    if (!asked.ok) return failed(action, `${asked.error.code}: ${asked.error.message}`)
    if (asked.value.status === 'answered') {
      // The Judge wrote its own two events; like the Mailbox it returns the
      // answer, not the seqs.
      return done(action, [])
    }
    return escalate(ask, asked.value.reason)
  })
}

// --------------------------------------------------------- §6.1 the inbox

export interface DecisionExecutorDeps {
  readonly store: EventSink
  readonly read: ReadModel
  readonly clock?: Clock
}

/** `request_decision` and `raise_no_work`: the two actions whose effect is an open row in §6.1's inbox. */
export const createDecisionExecutor = (deps: DecisionExecutorDeps): Executor => {
  const clock = deps.clock ?? systemClock

  const ask = async (action: PmAction, input: {
    readonly decisionId: string
    readonly kind: string
    readonly question: string
    readonly options: readonly string[]
    readonly workId?: string
    readonly inputsHash: string
    readonly routedTo?: string
  }): Promise<ActionOutcome> => {
    const written = await append(deps.store, [
      {
        type: 'decision.requested',
        ts: clock.now(),
        subject: input.workId ?? input.decisionId,
        actor: 'pm',
        causedBy: action.causedBy,
        data: {
          decisionId: input.decisionId,
          kind: input.kind,
          question: input.question,
          options: input.options,
          ...(input.workId === undefined ? {} : { workId: input.workId }),
          inputsHash: input.inputsHash,
          ...(input.routedTo === undefined ? {} : { routedTo: input.routedTo }),
        },
      } as AppendEvent,
    ])
    if ('error' in written) return failed(action, written.error)
    return done(action, written.seqs)
  }

  const request = async (action: RequestDecisionAction): Promise<ActionOutcome> =>
    ask(action, {
      decisionId: action.decisionId,
      kind: action.decisionKind,
      question: action.question,
      options: action.options,
      inputsHash: action.inputsHash,
      ...(action.workId === undefined ? {} : { workId: action.workId }),
      ...(action.routedTo === undefined ? {} : { routedTo: action.routedTo }),
    })

  const raiseNoWork = async (action: RaiseNoWorkAction): Promise<ActionOutcome> => {
    const kind = kindForNoWork(action.role)
    let open
    try {
      open = await deps.read.decisions.open()
    } catch (thrown) {
      return failed(action, toFleetError(thrown, 'store_failed').message)
    }
    // §5.2: once per dry spell, and the spell lasts while the question is open.
    if (open.some((decision) => decision.kind === kind)) return done(action, [])

    return ask(action, {
      decisionId: newDecisionId(),
      kind,
      question: action.reason,
      options: [],
      inputsHash: hashOf(kind, action.reason),
      routedTo: 'user',
    })
  }

  return executor(['request_decision', 'raise_no_work'], async (action) =>
    action.kind === 'request_decision' ? request(action) : raiseNoWork(action as RaiseNoWorkAction),
  )
}

// ------------------------------------------------------------- §6 standup

export interface StandupExecutorDeps {
  readonly store: EventSink
  readonly read: ReadModel
  readonly clock?: Clock
}

/**
 * `render_standup`: read the projections once, render, record.
 *
 * The reads run together rather than one per section, so the report is one
 * snapshot of the fleet instead of a sequence of moments (§3).
 */
export const createStandupExecutor = (deps: StandupExecutorDeps): Executor => {
  const clock = deps.clock ?? systemClock

  const render = async (action: RenderStandupAction): Promise<ActionOutcome> => {
    let state
    let pending: Map<string, number>
    try {
      const [peers, work, pullRequests, decisions] = await Promise.all([
        deps.read.peers.all(),
        deps.read.work.all(),
        deps.read.pullRequests.all(),
        deps.read.decisions.all(),
      ])
      const counts = await Promise.all(
        peers.map(async (peer) => [peer.peerId, (await deps.read.messages.forPeer(peer.peerId, unacked)).length] as const),
      )
      state = { peers, work, pullRequests, decisions }
      pending = new Map(counts)
    } catch (thrown) {
      return failed(action, toFleetError(thrown, 'store_failed').message)
    }

    const rendered = renderStandup(state, action.date, pending)
    const written = await append(deps.store, [
      {
        type: 'standup.rendered',
        ts: clock.now(),
        subject: action.date,
        actor: 'pm',
        causedBy: action.causedBy,
        data: { date: action.date, ...rendered },
      } as AppendEvent,
    ])
    if ('error' in written) return failed(action, written.error)
    return done(action, written.seqs)
  }

  return executor(['render_standup'], (action) => render(action as RenderStandupAction))
}

// ------------------------------------------------------------ §5.2 capacity

/**
 * `flag_capacity`: succeeds without writing, on purpose.
 *
 * §5.2 is explicit that a peer's capacity is a projection of its provider's
 * state (§4) and not something the PM may write. So the fact this action
 * asserts is already in the log — as that peer's `peer.state_changed` — and the
 * action's job is to reach an executor that says so instead of leaving the
 * daemon reporting "no executor is wired for 'flag_capacity'".
 */
export const createCapacityExecutor = (): Executor =>
  executor(['flag_capacity'], async (action) => done(action as FlagCapacityAction, []))

// -------------------------------------------------------------- the wiring

export interface DaemonExecutorDeps {
  readonly store: EventSink
  readonly read: ReadModel
  readonly mailbox: Mailbox
  readonly judge: JudgeService
  readonly clock?: Clock
}

/** Every kind this app owns, as the router wants them: one entry per dependency group (§5.2). */
export const createDaemonExecutors = (deps: DaemonExecutorDeps): readonly KindExecutor[] => [
  { kinds: ['send_message'], executor: createMailboxExecutor({ mailbox: deps.mailbox }) },
  {
    kinds: ['request_judge'],
    executor: createJudgeExecutor({ judge: deps.judge, store: deps.store, ...(deps.clock === undefined ? {} : { clock: deps.clock }) }),
  },
  {
    kinds: ['request_decision', 'raise_no_work'],
    executor: createDecisionExecutor({ store: deps.store, read: deps.read, ...(deps.clock === undefined ? {} : { clock: deps.clock }) }),
  },
  {
    kinds: ['render_standup'],
    executor: createStandupExecutor({ store: deps.store, read: deps.read, ...(deps.clock === undefined ? {} : { clock: deps.clock }) }),
  },
  { kinds: ['flag_capacity'], executor: createCapacityExecutor() },
]
