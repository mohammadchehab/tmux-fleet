/**
 * The CLI and the daemon, over a real socket (§2).
 *
 * This is the test that holds the two halves of the protocol together. The CLI
 * checks every request against `daemonParamsFor` and every answer against
 * `daemonResultFor`, both from `foundation/contracts/daemon-rpc.ts`; the daemon
 * decodes the same way and answers with the store's §3/§7 projections. Each side
 * is unit-tested against a fake of the other, and a fake is exactly where drift
 * hides: the daemon once returned its own flattened rows (`{id, provider,
 * pending}`) while the CLI expected `Peer`, and every unit test on both sides
 * stayed green.
 *
 * So this file asserts the one thing neither side can assert alone — that what
 * `fleetd` writes on the wire is what `fleet` decodes — for every method of the
 * port. `tests/integration` may import both apps (§1.1); nothing else may.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  newDecisionId,
  newEvalRunId,
  type DecisionId,
  type EvalRunId,
  type PeerId,
  type Sha,
} from '../../../packages/foundation/core/src/index.ts'
import { callDaemon, callerFor, isUnreachable } from '../../../apps/clients/cli/src/client.ts'
import { createSandbox } from '../support/sandbox.ts'
import type { Sandbox } from '../support/sandbox.ts'

/** The peers the sandbox profile declares, in the order `up` registers them. */
const peers = ['architect', 'engineer-1', 'engineer-2']

/** One open decision in the store, so `ls` has an inbox and `decide` something to answer. */
const requestDecision = async (sandbox: Sandbox): Promise<DecisionId> => {
  const decisionId = newDecisionId()
  await sandbox.composed.store.append([
    {
      type: 'decision.requested',
      ts: new Date().toISOString(),
      subject: decisionId,
      actor: 'pm',
      data: {
        decisionId,
        kind: 'merge_pr',
        question: 'merge #42?',
        options: ['yes', 'no'],
        inputsHash: 'abcdef12',
      },
    },
  ])
  return decisionId
}

test('every method of the port round-trips: the CLI decodes what the daemon answers', async (t) => {
  const sandbox = await createSandbox()
  t.after(() => sandbox.stop())
  const call = callerFor({ socketPath: sandbox.paths.socketPath })

  // `up`: the status `ls` repeats, so a client that attached to a running
  // daemon still learns everything `up` would have told it.
  const status = await call('up', {})
  assert.equal(status.profile, 'exit-test')
  assert.equal(status.socketPath, sandbox.paths.socketPath)
  assert.equal(typeof status.pid, 'number')

  // `send` and `peek`: the id the Mailbox minted is the id `peek` shows, and
  // the row it shows is §7's `Message` — state and brief version included.
  const sent = await call('send', { to: 'engineer-1' as PeerId, kind: 'info', body: 'round trip' })
  assert.match(String(sent.msgId), /^msg_[0-9a-f]{16}$/)
  const peeked = await call('peek', { peer: 'engineer-1' as PeerId })
  assert.deepEqual(
    peeked.messages.map((message) => String(message.msgId)),
    [String(sent.msgId)],
  )
  assert.equal(peeked.messages[0]?.body, 'round trip')
  assert.equal(String(peeked.messages[0]?.to), 'engineer-1')

  // `ls`: the peers are the §3 projections and the decisions are §6.1's inbox,
  // which is the field that did not exist before this migration.
  const decisionId = await requestDecision(sandbox)
  const listing = await call('ls', {})
  assert.deepEqual(listing.peers.map((peer) => String(peer.peerId)).sort(), peers)
  assert.deepEqual(
    listing.decisions.map((decision) => String(decision.decisionId)),
    [String(decisionId)],
  )
  assert.equal(listing.decisions[0]?.state, 'open')

  // `decide` answers it, and answers with the row as it now stands.
  const answered = await call('decide', { id: decisionId, decision: 'yes' })
  assert.equal(String(answered.decisionId), String(decisionId))
  assert.equal(answered.state, 'answered')
  assert.equal(answered.option, 'yes')
  const afterAnswer = await call('ls', {})
  assert.deepEqual(afterAnswer.decisions, [], 'an answered decision leaves the inbox')

  // `usage`: a peer's Stop hook reporting one finished turn (§6.2).
  const usage = await call('usage', {
    peerId: 'engineer-1' as PeerId,
    contextTokens: 1200,
    contextLimit: 200_000,
    inputTokens: 900,
    outputTokens: 300,
    cachedTokens: 800,
    toolCalls: { grep: 1, glob: 0, read: 2, codegraph: 3 },
  })
  assert.deepEqual(usage, { recorded: true })

  // `events.append`: an eval run's rows, handed over rather than written by the run
  // itself, because the store has one writer (§17). The start comes back with a seq,
  // and the rows and the total cite it — the same two batches `fleet evals run` sends.
  const runId = newEvalRunId()
  const at = new Date().toISOString()
  const sha = 'a1b2c3d' as Sha
  const row = { ts: at, subject: runId, actor: 'scheduler' as const }
  const [startSeq] = (
    await call('events.append', {
      events: [
        {
          ...row,
          type: 'eval.run_started',
          data: { runId, suite: 'judge', sha, provider: 'deepinfra', model: 'a-model', cases: 1 },
        },
      ],
    })
  ).seqs
  assert.equal(typeof startSeq, 'number')
  const restSeqs = (
    await call('events.append', {
      events: [
        {
          ...row,
          type: 'eval.case_scored',
          causedBy: [startSeq as number],
          data: { runId, caseId: 'case-a', attempt: 1, pass: true, score: 1, detail: 'answered route_question:peerId=engineer-1' },
        },
        {
          ...row,
          type: 'eval.run_finished',
          causedBy: [startSeq as number],
          data: {
            runId,
            suite: 'judge',
            sha,
            provider: 'deepinfra',
            model: 'a-model',
            cases: 1,
            passed: 1,
            tokensIn: 0,
            tokensOut: 0,
            latencyMs: 5,
          },
        },
      ],
    })
  ).seqs
  assert.equal(restSeqs.length, 2)
  assert.ok((restSeqs[0] as number) > (startSeq as number), 'the rows follow the start they cite')

  // And the port is eval-only: a row from any other part of the log is refused by name.
  await assert.rejects(
    () =>
      call('events.append', {
        events: [{ ...row, type: 'turn.usage_recorded', data: {} }],
      } as never),
    /eval\./,
  )

  // The same run read back through `evals`: the two §17 projections as one, which
  // is what `fleet evals compare` puts side by side. No second write — the run
  // above is the one in the log.
  const compared = await call('evals', { runId })
  assert.equal(compared.run.runId, runId)
  assert.equal(compared.run.state, 'finished')
  assert.equal(compared.run.passed, 1)
  assert.deepEqual(
    compared.cases.map((scored) => [scored.caseId, scored.attempts, scored.passes]),
    [['case-a', 1, 1]],
  )
  // A run the log never opened is the daemon's `not_found`, not an empty run the
  // CLI would print as zero cases.
  await assert.rejects(() => call('evals', { runId: 'evr_0000000000000000' as EvalRunId }), /no eval run evr_0000000000000000/)

  // `replay` (§5.4): the window is the log read back, the rebuild is the same log
  // walked into the projections again. Both go over the socket, so this is also
  // the check that the events the daemon writes decode as `FleetEvent` in a client.
  const window = await call('replay', { from: 1 })
  assert.equal(window.mode, 'window')
  if (window.mode === 'window') {
    assert.deepEqual(window.events.map((event) => event.seq), window.events.map((_, index) => index + 1))
    assert.ok(window.events.some((event) => event.type === 'eval.run_finished'), 'the window is the real log')
  }
  assert.ok(window.mode === 'window' && window.events.length > 0, 'the fleet has a log by now')

  // `to` on its own names no window: the daemon refuses rather than reading it as
  // "rebuild everything", which is the mistake that would cost someone their rows.
  await assert.rejects(() => call('replay', { to: 5 }), /give a `from` seq/)

  const rebuilt = await call('replay', {})
  assert.equal(rebuilt.mode, 'rebuild')
  if (rebuilt.mode === 'rebuild' && window.mode === 'window') {
    assert.equal(rebuilt.events, window.events.length, 'the rebuild replayed the whole log')
    assert.equal(rebuilt.latestSeq, window.events.at(-1)?.seq, 'and the log did not move')
  }
  // The projections were dropped and derived again: the run above still reads.
  assert.equal((await call('evals', { runId })).run.passed, 1)

  // `down` answers before the socket goes away, so the CLI is not left hanging.
  assert.deepEqual(await call('down', {}), { stopped: true })
})

test('a refusal travels as the daemon\'s own code, not as an internal error', async (t) => {
  const sandbox = await createSandbox()
  t.after(() => sandbox.stop())
  await callDaemon({ socketPath: sandbox.paths.socketPath }, 'up', {})

  // The CLI validated the params, the socket carried them, and the daemon
  // answered `not_found` — which is the code the CLI reports, unchanged.
  const error = await callDaemon(
    { socketPath: sandbox.paths.socketPath },
    'send',
    { to: 'nobody' as PeerId, kind: 'info', body: 'hello' },
  ).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.equal((error as { code?: string }).code, 'not_found')
  assert.equal(isUnreachable(error), false, 'the daemon answered: this is a refusal, not a dead socket')

  // And the params half of the contract is the CLI's, before a socket is even
  // opened: a bad peer id is refused with the field named.
  await assert.rejects(
    () => callDaemon({ socketPath: sandbox.paths.socketPath }, 'send', { to: 'no body' as PeerId, kind: 'info', body: 'x' }),
    /to: expected a valid PeerId/,
  )
})
