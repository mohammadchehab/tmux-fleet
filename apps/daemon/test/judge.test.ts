/**
 * The Judge as `apps/daemon` owns it (§5.3, §5.4): the log it replays from and
 * the wiring that puts a model behind it.
 *
 * Two properties are worth more than any single answer, and both are here:
 * an answer already in the log is **reused, not re-asked** — so a restart or a
 * repeated tick cannot get a second, different answer for the same inputs — and
 * a model that cannot produce a valid answer after its retry is reported as
 * `failed` for the caller to escalate, never guessed at.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type Clock, type Seq } from '@fleet/foundation-core'
import { appendIssues, type AppendEvent, type FleetEvent } from '@fleet/foundation-contracts'
import type { EventStore } from '@fleet/foundation-store'
import { hashInputs, type JudgeTransport, type JudgeRequest } from '@fleet/orchestration-judge'

import { createDaemonJudge, createJudgeLog, DEFAULT_JUDGE_MODEL } from '../src/judge.ts'

/** A value of a shape this test only partly fills; the fields used are the ones named. */
const row = <T>(value: unknown): T => value as T

const clock: Clock = { now: () => '2026-11-10T09:00:00.000Z', millis: () => Date.UTC(2026, 10, 10, 9) }

/** The one question every case asks: is this card too thin to assign? */
const input = { kind: 'thin_card', title: 'Add pagination', goal: 'paginate the list', acceptance: ['paging works'] } as const
const inputsHash = hashInputs('thin_card', input)

const question = (questionId = 'qst_0123456789abcdef') =>
  row<Parameters<ReturnType<typeof createDaemonJudge>['ask']>[0]>({
    questionId,
    kind: 'thin_card',
    input,
    inputsHash: 'sha256:the-pm-made-this-up',
  })

/**
 * A store with the two faces the Judge uses: `append` assigns seqs, `iterate`
 * serves them from a watermark. The rest of `EventStore` is not exercised here,
 * so it is cast rather than faked.
 */
const store = () => {
  const events: FleetEvent[] = []
  const scans: Seq[] = []
  return {
    events,
    scans,
    async append(batch: readonly AppendEvent[]): Promise<readonly Seq[]> {
      for (const event of batch) {
        const issues = appendIssues(event)
        assert.deepEqual(issues, [], `the judge appended an event the store would refuse: ${event.type}`)
      }
      return batch.map((event) => {
        const seq = events.length + 1
        events.push(row<FleetEvent>({ ...event, seq }))
        return seq
      })
    },
    async *iterate(from: Seq): AsyncIterable<FleetEvent> {
      scans.push(from)
      for (const event of events) if (event.seq >= from) yield event
    },
  }
}

const eventStore = (fake: ReturnType<typeof store>): EventStore => row<EventStore>(fake)

/** A transport that answers with `reply` every time, and remembers what it was asked. */
const transport = (reply: (request: JudgeRequest) => string) => {
  const requests: JudgeRequest[] = []
  const fake: JudgeTransport = {
    async complete(request) {
      requests.push(request)
      return { text: reply(request), model: request.model }
    },
  }
  return { transport: fake, requests }
}

const THIN = JSON.stringify({ kind: 'thin_card', thin: true, missing: ['acceptance criteria'], why: 'no tests named' })

// ------------------------------------------------------------- the log (§5.4)

test('an answer already in the log is found for its (kind, inputsHash), so a restart replays it', async () => {
  const fake = store()
  const judged = createDaemonJudge({
    store: eventStore(fake),
    transport: transport(() => THIN).transport,
    clock,
  })
  const first = await judged.ask(question())
  assert.equal(first.ok && first.value.status, 'answered')

  // A new process reads the same log: nothing carries over in memory.
  const reread = createJudgeLog(eventStore(fake))
  const found = await reread.findAnswered(inputsHash, 'thin_card')
  assert.equal(found?.model, DEFAULT_JUDGE_MODEL)
  assert.deepEqual(found?.answer, { kind: 'thin_card', thin: true, missing: ['acceptance criteria'], why: 'no tests named' })
})

test('the log is scanned from its watermark, so a long-running daemon does not rescan the fleet', async () => {
  const fake = store()
  await createDaemonJudge({ store: eventStore(fake), transport: transport(() => THIN).transport, clock }).ask(question())

  const log = createJudgeLog(eventStore(fake))
  fake.scans.length = 0
  assert.ok((await log.findAnswered(inputsHash, 'thin_card')) !== undefined)
  const afterFirst = fake.events.length
  assert.deepEqual(fake.scans, [1])

  // One more event lands, as it would on every tick.
  await fake.append([
    row<AppendEvent>({
      type: 'standup.rendered',
      ts: clock.now(),
      subject: '2026-11-10',
      actor: 'pm',
      data: { date: '2026-11-10', text: 'Standup 2026-11-10', peers: 0, openDecisions: 0 },
    }),
  ])
  const caught = await log.findAnswered(inputsHash, 'thin_card')
  assert.ok(caught !== undefined, 'an answer stays found after the log grows')
  assert.ok(fake.scans[1] === afterFirst + 1, 'the second read started at the event after the watermark')
})

test('an answer whose question the log never held is not replayed: there is no hash to file it under', async () => {
  const fake = store()
  // The request was written by a process this one never saw, so only the answer is here.
  fake.events.push(
    row<FleetEvent>({
      seq: 1,
      ts: clock.now(),
      type: 'judge.answered',
      subject: 'qst_0123456789abcdef',
      actor: `judge:${DEFAULT_JUDGE_MODEL}`,
      data: {
        questionId: 'qst_0123456789abcdef',
        kind: 'thin_card',
        answer: { kind: 'thin_card', thin: true, missing: ['acceptance criteria'], why: 'no tests named' },
        model: DEFAULT_JUDGE_MODEL,
        durationMs: 5,
        retries: 0,
      },
    }),
  )

  const log = createJudgeLog(eventStore(fake))
  assert.equal(await log.findAnswered(inputsHash, 'thin_card'), undefined)
})

test('concurrent asks share one scan rather than each walking the log (§5.3)', async () => {
  const fake = store()
  await createDaemonJudge({ store: eventStore(fake), transport: transport(() => THIN).transport, clock }).ask(question())
  const log = createJudgeLog(eventStore(fake))
  fake.scans.length = 0

  const [a, b] = await Promise.all([log.findAnswered(inputsHash, 'thin_card'), log.findAnswered(inputsHash, 'thin_card')])
  assert.ok(a !== undefined && b !== undefined)
  assert.equal(fake.scans.length, 1)
})

// ---------------------------------------------------------- the wiring (§5.3)

test('createDaemonJudge answers through the transport and records both events, with the model as the actor', async () => {
  const fake = store()
  const scripted = transport(() => THIN)
  const judged = createDaemonJudge({ store: eventStore(fake), transport: scripted.transport, clock })

  const outcome = await judged.ask(question())
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.value.status, 'answered')
  assert.equal(outcome.ok && outcome.value.status === 'answered' ? outcome.value.cached : undefined, false)

  // The transport was asked with the cheap model and a schema, never with free text.
  assert.deepEqual(scripted.requests.map((request) => request.model), [DEFAULT_JUDGE_MODEL])
  assert.ok(Object.keys(scripted.requests[0]?.schema ?? {}).length > 0, 'the answer is constrained by a schema')

  assert.deepEqual(
    fake.events.map((event) => event.type),
    ['judge.requested', 'judge.answered'],
  )
  const answered = fake.events[1]
  assert.equal(answered?.actor, `judge:${DEFAULT_JUDGE_MODEL}`)
})

test('the same question asked twice is answered once: the second call is a replay (§5.4)', async () => {
  const fake = store()
  const scripted = transport(() => THIN)
  const judged = createDaemonJudge({ store: eventStore(fake), transport: scripted.transport, clock })

  const first = await judged.ask(question('qst_0123456789abcdef'))
  const second = await judged.ask(question('qst_1111111111111111'))
  assert.equal(first.ok && first.value.status === 'answered' ? first.value.cached : undefined, false)
  assert.equal(second.ok && second.value.status === 'answered' ? second.value.cached : undefined, true)
  // One model call for two asks: a repeated tick cannot produce a second, different answer.
  assert.equal(scripted.requests.length, 1)
})

test('an answer that never validates is reported failed after one retry, so the caller escalates (§5.3)', async () => {
  const fake = store()
  const scripted = transport(() => 'I think it is probably fine?')
  const outcome = await createDaemonJudge({
    store: eventStore(fake),
    transport: scripted.transport,
    clock,
  }).ask(question())

  assert.equal(outcome.ok, true, 'a model that cannot answer is an outcome, not an error')
  assert.equal(outcome.ok && outcome.value.status, 'failed')
  assert.equal(outcome.ok && outcome.value.status === 'failed' ? outcome.value.retries : undefined, 1)
  // Asked twice, then stopped: hammering a model that cannot answer helps nobody.
  assert.equal(scripted.requests.length, 2)
  // Nothing was recorded as an answer, so nothing can be replayed as one.
  assert.deepEqual(
    fake.events.map((event) => event.type),
    ['judge.requested'],
  )
})

test('a profile can name a stronger model per kind, and the default stays the cheap one (§5.3)', async () => {
  const fake = store()
  const scripted = transport(() => THIN)
  await createDaemonJudge({
    store: eventStore(fake),
    transport: scripted.transport,
    model: 'claude-haiku-4-5',
    models: { thin_card: 'claude-sonnet-5-5' },
    clock,
  }).ask(question())

  assert.deepEqual(scripted.requests.map((request) => request.model), ['claude-sonnet-5-5'])
})

test('a store that refuses the question is an error, not a silent answer', async () => {
  const judged = createDaemonJudge({
    store: row<EventStore>({
      append: async () => {
        throw new Error('the database is locked')
      },
      iterate: async function* () {
        return
      },
    }),
    transport: transport(() => THIN).transport,
    clock,
  })

  const outcome = await judged.ask(question())
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok ? '' : `${outcome.error.code}: ${outcome.error.message}`, /store_failed/)
})
