/**
 * The executor router (§5.2): one `ActionExecutor`, several executors behind it.
 *
 * The tests are about *ordering and survivability*, because that is what §5.2
 * buys: every action is attempted, in the PM's order, and one failure never
 * costs the rest of the tick.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ActionOutcome, ExecuteRequest, PmAction, PmActionKind } from '@fleet/foundation-contracts'
import type { Seq } from '@fleet/foundation-core'

import { createExecutorRouter, type KindExecutor } from '../src/executor.ts'

const action = (kind: PmActionKind): PmAction =>
  ({
    kind,
    causedBy: [1] as readonly Seq[],
    to: 'engineer-1',
    messageKind: 'info',
    body: 'go',
    briefVersion: 1,
  }) as unknown as PmAction

/** An executor that records what it was handed and answers with whatever the test said. */
const recorder = (
  kinds: readonly PmActionKind[],
  answer: (kind: PmActionKind) => ActionOutcome['ok'] | 'throw' = () => true,
): KindExecutor & { readonly seen: readonly PmActionKind[] } => {
  const seen: PmActionKind[] = []
  return {
    kinds,
    seen,
    executor: {
      async execute(request: ExecuteRequest) {
        const outcomes: ActionOutcome[] = []
        for (const one of request.actions) {
          seen.push(one.kind)
          const verdict = answer(one.kind)
          if (verdict === 'throw') throw new Error(`boom from ${one.kind}`)
          outcomes.push({ action: one, ok: verdict, seqs: [] })
        }
        return {
          outcomes,
          executed: outcomes.filter((outcome) => outcome.ok).length,
          failed: outcomes.filter((outcome) => !outcome.ok).length,
        }
      },
    },
  }
}

test('routes each action to the executor that claims its kind, in the PM order', async () => {
  const gate = recorder(['merge', 'retarget'])
  const mail = recorder(['send_message'])
  const router = createExecutorRouter({ executors: [gate, mail] })

  const report = await router.execute({
    actions: [action('send_message'), action('merge'), action('send_message')],
    routineId: 'rtn_dispatch',
  })

  assert.deepEqual(mail.seen, ['send_message', 'send_message'])
  assert.deepEqual(gate.seen, ['merge'])
  assert.deepEqual(
    report.outcomes.map((outcome) => outcome.action.kind),
    ['send_message', 'merge', 'send_message'],
    'the report is in the order the PM decided, not the order the executors ran',
  )
  assert.equal(report.executed, 3)
  assert.equal(report.failed, 0)
})

test('one action goes to its executor at a time, so no executor can reorder a tick', async () => {
  const order: string[] = []
  const slow = (kind: PmActionKind): KindExecutor => ({
    kinds: [kind],
    executor: {
      async execute(request) {
        order.push(`start:${request.actions[0]?.kind ?? 'none'}:${request.actions.length}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push(`end:${request.actions[0]?.kind ?? 'none'}`)
        return {
          outcomes: (request.actions ?? []).map((one: PmAction) => ({ action: one, ok: true, seqs: [] })),
          executed: 1,
          failed: 0,
        }
      },
    },
  })
  const router = createExecutorRouter({ executors: [slow('send_message'), slow('merge')] })

  await router.execute({ actions: [action('merge'), action('send_message')], routineId: 'rtn' })

  assert.deepEqual(order, ['start:merge:1', 'end:merge', 'start:send_message:1', 'end:send_message'])
})

test('a kind nobody claims fails visibly rather than being dropped', async () => {
  const router = createExecutorRouter({ executors: [] })
  const report = await router.execute({ actions: [action('render_standup')], routineId: 'rtn' })

  assert.equal(report.failed, 1)
  assert.equal(report.executed, 0)
  assert.match(report.outcomes[0]?.error ?? '', /no executor is wired for 'render_standup'/)
  assert.deepEqual(report.outcomes[0]?.seqs, [])
})

test('a throwing executor becomes that action failure, and the rest still run', async () => {
  const gate = recorder(['merge'], (kind) => (kind === 'merge' ? 'throw' : true))
  const mail = recorder(['send_message'])
  const router = createExecutorRouter({ executors: [gate, mail] })

  const report = await router.execute({
    actions: [action('merge'), action('send_message')],
    routineId: 'rtn',
  })

  assert.equal(report.failed, 1)
  assert.equal(report.executed, 1)
  assert.match(report.outcomes[0]?.error ?? '', /internal: boom from merge/)
  assert.deepEqual(mail.seen, ['send_message'], 'the failure did not cost the next action')
})

test('two executors claiming one kind is a wiring bug, refused at construction', () => {
  assert.throws(
    () => createExecutorRouter({ executors: [recorder(['merge']), recorder(['merge'])] }),
    /two executors claim 'merge'/,
  )
})

test('an executor that answers with no outcome for its action did not run it', async () => {
  const empty: KindExecutor = {
    kinds: ['merge'],
    executor: {
      async execute() {
        return { outcomes: [], executed: 0, failed: 0 }
      },
    },
  }
  const router = createExecutorRouter({ executors: [empty] })
  const report = await router.execute({ actions: [action('merge')], routineId: 'rtn' })

  assert.equal(report.failed, 1)
  assert.match(report.outcomes[0]?.error ?? '', /returned no outcome/)
})

test('seqs an action wrote are reported to the caller, and the outcome is passed through untouched', async () => {
  const wrote: readonly Seq[][] = []
  const gate: KindExecutor = {
    kinds: ['merge'],
    executor: {
      async execute(request) {
        const one = request.actions[0] as PmAction
        return { outcomes: [{ action: one, ok: true, seqs: [12, 13] as readonly Seq[] }], executed: 1, failed: 0 }
      },
    },
  }
  const router = createExecutorRouter({
    executors: [gate],
    onAppended: (seqs) => {
      ;(wrote as Seq[][]).push([...seqs])
    },
  })

  const report = await router.execute({ actions: [action('merge')], routineId: 'rtn', causedBySeq: 7 as Seq })

  assert.deepEqual(report.outcomes[0]?.seqs, [12, 13])
  assert.deepEqual(wrote, [[12, 13]])
})

test('empty is a legitimate tick', async () => {
  const router = createExecutorRouter({ executors: [] })
  const report = await router.execute({ actions: [], routineId: 'rtn' })
  assert.deepEqual(report, { outcomes: [], executed: 0, failed: 0 })
})
