/**
 * The six actions `apps/daemon` carries out (§5.2): `send_message`,
 * `request_judge`, `request_decision`, `raise_no_work`, `render_standup` and
 * `flag_capacity`.
 *
 * Every case is one of the three things that can happen to an action: a
 * dependency refuses (a Mailbox that will not send, a store that will not
 * append), a dependency fails in a way §5.3 says to escalate, or it succeeds and
 * the events it wrote are exactly the ones the section names. The events are
 * decoded with the real append boundary, so a misspelt field fails here rather
 * than in a replay six weeks later (§3).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  err,
  fleetError,
  newDecisionId,
  newMessageId,
  ok,
  parse,
  peerId,
  type Clock,
  type DistributiveOmit,
  type PeerId,
  type QuestionId,
  type WorkId,
} from '@fleet/foundation-core'
import {
  appendIssues,
  type ActionExecutor,
  type AppendEvent,
  type Decision,
  type EventSink,
  type JudgeAnswer,
  type Mailbox,
  type Message,
  type OutboundMessage,
  type PmAction,
  type PullRequest,
  type ReadModel,
  type Work,
} from '@fleet/foundation-contracts'
import type { JudgeService } from '@fleet/orchestration-judge'

import {
  createCapacityExecutor,
  createDaemonExecutors,
  createDecisionExecutor,
  createJudgeExecutor,
  createMailboxExecutor,
  createStandupExecutor,
  NO_WORK_KIND,
} from '../src/executors.ts'
import { createExecutorRouter } from '../src/executor.ts'

/** A value of a shape this test only partly fills; the fields used are the ones named. */
const row = <T>(value: unknown): T => value as T

const engineer: PeerId = parse(peerId(), 'engineer-1')
/** Every action in a test was caused by the same event, so `causedBy` is one seq (§3). */
const causedBy = [1] as const

const clock: Clock = { now: () => '2026-11-10T09:00:00.000Z', millis: () => Date.UTC(2026, 10, 10, 9) }

/**
 * One decision the PM could make, tagged with the events that caused it. The
 * parameter is the union distributed over its kinds, so each literal is checked
 * against its own action's shape instead of against the fields they share.
 */
const action = (value: DistributiveOmit<PmAction, 'causedBy'>): PmAction => row({ ...value, causedBy })

// ------------------------------------------------------------------- fakes

/** A store that records what was appended and hands back the next seqs. */
const sink = (options: { readonly fail?: 'append' } = {}): EventSink & { readonly appended: AppendEvent[] } => {
  const appended: AppendEvent[] = []
  return {
    appended,
    async append(batch) {
      if (options.fail === 'append') throw new Error('the store is not writable')
      const seqs: number[] = []
      for (const event of batch) {
        appended.push(event)
        seqs.push(appended.length)
      }
      return seqs
    },
  }
}

/**
 * A read model with only what these executors read. Every list is empty unless
 * a test overrides it, so a test that forgets a projection sees an empty fleet
 * rather than another test's rows.
 */
const readModel = (overrides: Partial<ReadModel> = {}): ReadModel => {
  const empty = async (): Promise<readonly never[]> => []
  return row<ReadModel>({
    peers: { all: empty, get: async () => undefined },
    sessions: { all: empty, forPeer: empty },
    work: { all: empty, get: async () => undefined },
    decisions: { all: empty, open: empty, get: async () => undefined },
    notifications: { all: empty, get: async () => undefined },
    findings: { all: empty },
    messages: { all: empty, forPeer: empty },
    pullRequests: { all: empty },
    worktrees: { all: empty },
    routines: { all: empty },
    ...overrides,
  })
}

interface Outcome {
  readonly ok: boolean
  readonly seqs: readonly number[]
  readonly error?: string
}

/** Run one action through one executor and report what it did with it. */
const outcomeOf = async (executor: ActionExecutor, one: PmAction): Promise<Outcome> => {
  const report = await executor.execute({ actions: [one], routineId: 'rtn_0123456789abcdef' })
  const outcome = report.outcomes[0]
  assert.ok(outcome !== undefined, 'the executor reported an outcome')
  return outcome
}

/**
 * The appended events, checked against the append boundary the store itself
 * uses (§3): an event a real store would refuse cannot pass a test here.
 */
const decoded = (appended: readonly AppendEvent[]): readonly { type: string; subject: string; data: Record<string, any> }[] => {
  const issues = appended.flatMap((event) => appendIssues(event).map((issue) => `${event.type}.${String(issue.path)}: ${issue.message}`))
  assert.deepEqual(issues, [], 'every appended event must decode at the append boundary')
  return appended as unknown as { type: string; subject: string; data: Record<string, any> }[]
}

/** Only the one event a test appended, so its fields can be read without indexing. */
const only = (appended: readonly AppendEvent[]): { type: string; subject: string; data: Record<string, any> } => {
  assert.equal(appended.length, 1, 'exactly one event was expected')
  const [event] = decoded(appended)
  assert.ok(event !== undefined)
  return event
}

// ------------------------------------------------------------- §7 send_message

const mailbox = (
  options: { readonly send?: Mailbox['send']; readonly deliver?: Mailbox['deliver'] } = {},
): { readonly mailbox: Mailbox; readonly sent: OutboundMessage[]; readonly delivered: PeerId[] } => {
  const sent: OutboundMessage[] = []
  const delivered: PeerId[] = []
  const fake: Mailbox = {
    async send(message) {
      sent.push(message)
      return options.send === undefined ? ok(newMessageId()) : options.send(message)
    },
    async deliver(to) {
      delivered.push(to)
      return options.deliver === undefined
        ? ok({ peerId: to, delivered: [], resumed: false, failures: [] })
        : options.deliver(to)
    },
    async pending() {
      return []
    },
    async ack() {
      return ok(undefined)
    },
    async reject() {
      return ok(undefined)
    },
    async history() {
      return []
    },
  }
  return { mailbox: fake, sent, delivered }
}

test('send_message sends from the PM, then delivers it in the same action (§7)', async () => {
  const deps = mailbox()
  const outcome = await outcomeOf(
    createMailboxExecutor({ mailbox: deps.mailbox }),
    action({ kind: 'send_message', to: engineer, messageKind: 'nudge', body: 'CI is red', briefVersion: 3 }),
  )

  assert.equal(outcome.ok, true)
  assert.equal(deps.sent.length, 1)
  assert.equal(deps.sent[0]?.to, engineer)
  assert.equal(deps.sent[0]?.from, 'pm')
  assert.equal(deps.sent[0]?.briefVersion, 3)
  // Delivered here, not left for a later tick: a nudge that waits is a nudge
  // that arrives after the thing it was about.
  assert.deepEqual(deps.delivered, [engineer])
  // The Mailbox writes the message events; the action reports the id, not the seqs.
  assert.deepEqual(outcome.seqs, [])
})

test('a message the Mailbox refused is a failed action, not a silent drop (§7)', async () => {
  const deps = mailbox({ send: async () => err(fleetError('invalid_input', 'briefVersion is stale')) })
  const outcome = await outcomeOf(
    createMailboxExecutor({ mailbox: deps.mailbox }),
    action({ kind: 'send_message', to: engineer, messageKind: 'info', body: 'fyi', briefVersion: 1 }),
  )

  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /invalid_input: briefVersion is stale/)
  // Nothing was handed to the provider for a message that was never accepted.
  assert.deepEqual(deps.delivered, [])
})

test('a delivery that failed keeps the message in the box and fails the action (§7 at-least-once)', async () => {
  const decided = newMessageId()
  const deps = mailbox({
    send: async () => ok(decided),
    deliver: async (to) => ok({ peerId: to, delivered: [], resumed: false, failures: [{ msgId: decided, reason: 'no_session' }] }),
  })
  const outcome = await outcomeOf(
    createMailboxExecutor({ mailbox: deps.mailbox }),
    action({ kind: 'send_message', to: engineer, messageKind: 'info', body: 'fyi', briefVersion: 1 }),
  )

  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /not delivered \(no_session\)/)
})

test('a Mailbox that throws is a failed action, not a lost tick (§5.2)', async () => {
  const deps = mailbox({
    send: async () => {
      throw new Error('the socket is gone')
    },
  })
  const outcome = await outcomeOf(
    createMailboxExecutor({ mailbox: deps.mailbox }),
    action({ kind: 'send_message', to: engineer, messageKind: 'info', body: 'fyi', briefVersion: 1 }),
  )

  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /socket is gone/)
})

// ---------------------------------------------------------- §5.3 request_judge

const judge = (ask: JudgeService['ask']): JudgeService =>
  row<JudgeService>({
    model: 'claude-haiku-4-5',
    ask,
    judge: () => {
      throw new Error('the executors ask through ask(), never model()')
    },
  })

const judgeAction = (): Extract<PmAction, { kind: 'request_judge' }> =>
  row(
    action({
      kind: 'request_judge',
      questionId: row<QuestionId>('qst_0123456789abcdef'),
      question: 'thin_card',
      input: { kind: 'thin_card', title: 'Add pagination', goal: 'paginate the list', acceptance: ['paging works'] },
      inputsHash: 'sha256:deadbeefdeadbeef',
      workId: row<WorkId>('wrk_0123456789abcdef'),
    }),
  )

test('request_judge reports the Judge answer and writes nothing of its own (§5.3)', async () => {
  const store = sink()
  const outcome = await outcomeOf(
    createJudgeExecutor({
      store,
      clock,
      judge: judge(async () =>
        ok({
          status: 'answered' as const,
          answer: row<JudgeAnswer>({ kind: 'thin_card' }),
          model: 'claude-haiku-4-5',
          retries: 0,
          cached: false,
        }),
      ),
    }),
    judgeAction(),
  )

  assert.equal(outcome.ok, true)
  // The Judge wrote `judge.requested` and `judge.answered`; a second write here
  // would make a second source of truth for one answer (§5.3).
  assert.deepEqual(store.appended, [])
})

test('a Judge that could not answer escalates to the user instead of failing the action (§5.3)', async () => {
  const store = sink()
  const outcome = await outcomeOf(
    createJudgeExecutor({
      store,
      clock,
      judge: judge(async () =>
        ok({ status: 'failed' as const, reason: 'the answer does not match the schema', retries: 1 }),
      ),
    }),
    judgeAction(),
  )

  // A model that cannot answer is the fleet learning something, not a broken
  // tick: the question goes to the user, where a person can answer it.
  assert.equal(outcome.ok, true)
  const event = only(store.appended)
  assert.equal(event.type, 'decision.requested')
  assert.equal(event.data['kind'], 'escalate')
  assert.equal(event.data['routedTo'], 'user')
  assert.equal(event.data['workId'], 'wrk_0123456789abcdef')
  assert.match(String(event.data['question']), /does not match the schema/)
})

test('a Judge whose store refused the escalation is a failed action', async () => {
  const outcome = await outcomeOf(
    createJudgeExecutor({
      store: sink({ fail: 'append' }),
      clock,
      judge: judge(async () => ok({ status: 'failed' as const, reason: 'nothing usable', retries: 1 })),
    }),
    judgeAction(),
  )

  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /store is not writable/)
})

// ------------------------------------------------------- §6.1 request_decision

test('request_decision opens the row the action named, with its kind and options', async () => {
  const store = sink()
  const decisionId = newDecisionId()
  const outcome = await outcomeOf(
    createDecisionExecutor({ store, read: readModel(), clock }),
    action({
      kind: 'request_decision',
      decisionId,
      decisionKind: 'scope',
      question: 'Does this card include exports?',
      options: ['yes', 'no'],
      workId: row<WorkId>('wrk_0123456789abcdef'),
      inputsHash: 'sha256:cafe',
      routedTo: 'user',
    }),
  )

  assert.equal(outcome.ok, true)
  const event = only(store.appended)
  assert.equal(event.type, 'decision.requested')
  assert.equal(event.data['decisionId'], decisionId)
  assert.equal(event.data['kind'], 'scope')
  assert.deepEqual(event.data['options'], ['yes', 'no'])
  // The subject is the work the decision is about, so the board can group it.
  assert.equal(event.subject, 'wrk_0123456789abcdef')
})

// ---------------------------------------------------------- §5.2 raise_no_work

test('raise_no_work is recorded once, as an open decision routed to the user (§5.2)', async () => {
  const store = sink()
  const outcome = await outcomeOf(
    createDecisionExecutor({ store, read: readModel(), clock }),
    action({ kind: 'raise_no_work', reason: 'nothing is assignable and engineer-1 is free' }),
  )

  assert.equal(outcome.ok, true)
  const event = only(store.appended)
  assert.equal(event.data['kind'], NO_WORK_KIND)
  assert.equal(event.data['routedTo'], 'user')
  assert.equal(event.data['question'], 'nothing is assignable and engineer-1 is free')
})

test('a dry spell already in the inbox is not raised a second time (§5.2 "once")', async () => {
  const store = sink()
  const open = row<Decision[]>([{ decisionId: newDecisionId(), kind: NO_WORK_KIND, state: 'open' }])
  const outcome = await outcomeOf(
    createDecisionExecutor({
      store,
      clock,
      read: readModel({ decisions: { all: async () => open, open: async () => open, get: async () => undefined } }),
    }),
    action({ kind: 'raise_no_work', reason: 'still nothing to do' }),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(store.appended, [])
})

test('a role-specific dry spell has its own kind, so the fleet-wide one does not hide it (§5.2)', async () => {
  const store = sink()
  const open = row<Decision[]>([{ decisionId: newDecisionId(), kind: NO_WORK_KIND, state: 'open' }])
  const outcome = await outcomeOf(
    createDecisionExecutor({
      store,
      clock,
      read: readModel({ decisions: { all: async () => open, open: async () => open, get: async () => undefined } }),
    }),
    action({ kind: 'raise_no_work', role: 'engineer', reason: 'no cards for engineering' }),
  )

  assert.equal(outcome.ok, true)
  assert.equal(only(store.appended).data['kind'], `${NO_WORK_KIND}:engineer`)
})

test('a dry-spell check that cannot read the inbox is a failed action (§5.2)', async () => {
  const outcome = await outcomeOf(
    createDecisionExecutor({
      store: sink(),
      clock,
      read: readModel({
        decisions: {
          all: async () => [],
          open: async () => {
            throw new Error('the database is locked')
          },
          get: async () => undefined,
        },
      }),
    }),
    action({ kind: 'raise_no_work', reason: 'nothing to do' }),
  )

  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /locked/)
})

// ---------------------------------------------------------------- §6 standup

const peerRow = (id: PeerId, role: string): never => row({ peerId: id, role, state: 'working' })

test('render_standup records one report, rendered from one snapshot of the fleet (§6)', async () => {
  const store = sink()
  const open = row<Decision[]>([{ decisionId: 'dec_0123456789abcdef', kind: 'scope', question: 'ship it?', state: 'open' }])
  const onePr = row<PullRequest[]>([
    { repo: 'o/r', number: 7, base: 'main', head: 'feat', checks: 'passing', review: 'approved', merged: false },
  ])
  const outcome = await outcomeOf(
    createStandupExecutor({
      store,
      clock,
      read: readModel({
        peers: { all: async () => [peerRow(engineer, 'engineer'), peerRow('architect' as PeerId, 'architect')], get: async () => undefined },
        work: { all: async () => row<Work[]>([{ state: 'ready' }, { state: 'ready' }]), get: async () => undefined },
        pullRequests: { all: async () => onePr },
        decisions: { all: async () => open, open: async () => open, get: async () => undefined },
        messages: { all: async () => [], forPeer: async () => row<Message[]>([{ msgId: newMessageId() }]) },
      }),
    }),
    action({ kind: 'render_standup', date: '2026-11-10' }),
  )

  assert.equal(outcome.ok, true)
  const event = only(store.appended)
  assert.equal(event.type, 'standup.rendered')
  assert.equal(event.data['date'], '2026-11-10')
  assert.equal(event.data['peers'], 2)
  assert.equal(event.data['openDecisions'], 1)

  const text = String(event.data['text'])
  assert.match(text, /^Standup 2026-11-10/)
  assert.match(text, /Peers \(2\)/)
  // The peer's unacked messages are on its line: what it is behind on, not just that it exists.
  assert.match(text, /engineer-1 +engineer +working +1 pending/)
  assert.match(text, /Work \(2\)\n +ready 2/)
  assert.match(text, /Pull requests \(1\)\n +o\/r#7 +main←feat +checks passing +review approved/)
  assert.match(text, /Waiting on you \(1\)\n +dec_0123456789abcdef +scope: ship it\?/)
})

test('a standup that cannot read the projections is a failed action, not an empty report (§6)', async () => {
  const outcome = await outcomeOf(
    createStandupExecutor({
      store: sink(),
      clock,
      read: readModel({
        peers: {
          all: async () => {
            throw new Error('the database is locked')
          },
          get: async () => undefined,
        },
      }),
    }),
    action({ kind: 'render_standup', date: '2026-11-10' }),
  )

  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /locked/)
})

// --------------------------------------------------------- §5.2 flag_capacity

test('flag_capacity succeeds without writing: capacity is a projection, not a state change (§5.2)', async () => {
  const store = sink()
  const outcome = await outcomeOf(
    createCapacityExecutor(),
    action({ kind: 'flag_capacity', peerId: engineer, reason: 'no work in flight' }),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.seqs, [])
  assert.deepEqual(store.appended, [])
})

// -------------------------------------------------------------- the wiring

const deps = () => {
  const box = mailbox()
  return {
    box,
    store: sink(),
    read: readModel(),
    clock,
    mailbox: box.mailbox,
    judge: judge(async () => ok({ status: 'failed' as const, reason: 'unused', retries: 0 })),
  }
}

test('the daemon owns exactly the six kinds it can carry out (§5.2)', () => {
  const wiring = deps()
  const kinds = createDaemonExecutors(wiring)
    .flatMap((entry) => entry.kinds)
    .sort()
  assert.deepEqual(kinds, [
    'flag_capacity',
    'raise_no_work',
    'render_standup',
    'request_decision',
    'request_judge',
    'send_message',
  ])
})

test('the gate stays the only home of merge and retarget, so a kind cannot be carried out twice (§10)', () => {
  const router = createExecutorRouter({ executors: createDaemonExecutors(deps()) })
  assert.equal(router.kinds.has('merge'), false)
  assert.equal(router.kinds.has('retarget'), false)
  assert.equal(router.kinds.size, 6)
})

test('an executor called with a kind it does not own says so rather than guessing (§5.2)', async () => {
  const wiring = deps()
  const outcome = await outcomeOf(
    createMailboxExecutor({ mailbox: wiring.mailbox }),
    action({ kind: 'flag_capacity', peerId: engineer, reason: 'x' }),
  )

  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /does not carry out 'flag_capacity'/)
})
