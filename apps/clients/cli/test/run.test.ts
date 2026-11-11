import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'


import {
  FleetError,
  type DecisionId,
  type EvalRunId,
  type PeerId,
  type Repo,
  type SessionId,
  type Sha,
  type WorkId,
} from '@fleet/foundation-core'
import { buildStdoutPath } from '@fleet/foundation-contracts'
import type { BuildsResult, DaemonMethod, EvalRunWithCases, LsResult } from '@fleet/foundation-contracts'
import { unreachableError, type DaemonCaller } from '../src/client.ts'
import { run, type RunDeps } from '../src/run.ts'

const now = '2026-11-10T09:00:00.000Z'
const socketPath = '/home/tester/.fleet/squad/daemon/fleetd.sock'

const status = { profile: 'squad', pid: 4242, startedAt: now, socketPath: '/home/tester/.fleet/squad/daemon/fleetd.sock', storePath: '/home/tester/.fleet/squad/store/store.sqlite', protocolVersion: 1 }

const peer = {
  peerId: 'engineer-1' as PeerId,
  role: 'engineer',
  providerId: 'claude',
  model: 'test-small',
  permissionMode: 'default' as const,
  briefVersion: 2,
  currentSessionId: 'ses_0123456789abcdef' as SessionId,
  state: 'working' as const,
  registeredAt: now,
  updatedAt: now,
}

const routine = {
  routineId: 'rtn_0123456789abcdef',
  kind: 'dispatch' as const,
  trigger: 'heartbeat' as const,
  state: 'finished' as const,
  lastRunAt: now,
  runs: 3,
  failures: 1,
}

const decision = {
  decisionId: 'dec_0123456789abcdef' as DecisionId,
  kind: 'route_question',
  state: 'open' as const,
  question: 'Which repo does the checkout belong to?',
  options: ['me-services', 'other'],
  inputsHash: 'abcdef0123',
  requestedAt: now,
}

const compactions = [
  { peerId: 'engineer-1' as PeerId, count: 2, lastAt: now, lastTrigger: 'manual' as const, lastPreTokens: 90000 },
]

const tokens = [
  { peerId: 'engineer-1' as PeerId, role: 'engineer', turns: 12, inputTokens: 12000, outputTokens: 3000, cachedTokens: 900, costUsd: 4.12, toolCalls: { grep: 1, glob: 0, read: 2, codegraph: 3 }, redirects: 0, updatedAt: now },
  { peerId: 'engineer-1' as PeerId, role: 'engineer', workId: 'wrk_7f3a91c2d84b0e56' as WorkId, turns: 8, inputTokens: 9000, outputTokens: 2000, cachedTokens: 600, costUsd: 3.01, toolCalls: { grep: 1, glob: 0, read: 1, codegraph: 2 }, redirects: 0, updatedAt: now },
]

const activity = [
  {
    peerId: 'engineer-1' as PeerId,
    workId: 'wrk_0123456789abcdef' as WorkId,
    lastTool: 'Edit',
    lastTarget: 'packages/foundation/store/src/projections.ts',
    lastToolAt: now,
    lastTurnAt: now,
    edits: 14,
  },
]

const listing: LsResult = {
  status,
  peers: [peer],
  routines: [routine],
  decisions: [decision],
  compactions,
  tokens,
  activity,
}

type Answer = (params: unknown) => unknown

interface Harness {
  readonly deps: RunDeps
  readonly calls: readonly { method: DaemonMethod; params: unknown }[]
  readonly out: readonly string[]
  readonly err: readonly string[]
  readonly started: readonly string[]
  readonly sockets: readonly string[]
}

const harness = (answers: Partial<Record<DaemonMethod, Answer>>, overrides: Partial<RunDeps> = {}): Harness => {
  const calls: { method: DaemonMethod; params: unknown }[] = []
  const out: string[] = []
  const err: string[] = []
  const started: string[] = []
  const sockets: string[] = []

  const call = (socket: string): DaemonCaller => {
    sockets.push(socket)
    return ((method: DaemonMethod, params: unknown) => {
      calls.push({ method, params })
      const answer = answers[method]
      if (answer === undefined) throw new Error(`the test has no answer for ${method}`)
      return Promise.resolve(answer(params))
    }) as unknown as DaemonCaller
  }

  const deps: RunDeps = {
    call,
    startFleetd: (profile) => {
      started.push(profile)
      return Promise.resolve()
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    // What a shell that has been using one fleet has exported, and what `fleetd`
    // itself reads; the test that names no fleet overrides this with `{}`.
    env: { FLEET_PROFILE: 'squad' },
    home: '/home/tester',
    // The layout under `home` is a string in these tests, not a filesystem.
    profileFileExists: () => true,
    sleep: () => Promise.resolve(),
    ...overrides,
  }
  return { deps, calls, out, err, started, sockets }
}

const argv = (...words: readonly string[]): readonly string[] => ['node', 'fleet', ...words]

const unreachable = (): never => {
  throw unreachableError(`cannot reach fleetd at ${socketPath}: connect ENOENT`)
}

describe('run: the command line', () => {
  it('prints the commands when asked for nothing, and exits 0', async () => {
    const { deps, out } = harness({})
    assert.equal(await run(argv(), deps), 0)
    assert.match(out[0] ?? '', /fleet up \[profile\]/)
    assert.match(out[0] ?? '', /kinds: brief \| answer \| nudge \| info/)
  })

  it('refuses an unknown command with exit 2 and never reaches the daemon', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('launch'), deps), 2)
    assert.match(err[0] ?? '', /unknown command launch/)
    assert.deepEqual(calls, [])
  })

  it('refuses an option it does not have', async () => {
    const { deps, err } = harness({})
    assert.equal(await run(argv('ls', '--fast'), deps), 2)
    assert.match(err[0] ?? '', /unknown option --fast/)
  })

  it('asks which fleet to talk to when nothing names one', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('ls'), { ...deps, env: {} }), 2)
    assert.match(err[0] ?? '', /no fleet named/)
    assert.deepEqual(calls, [])
  })
})

describe('run: ls', () => {
  it('points at the command that starts the fleet it cannot reach', async () => {
    const { deps, err } = harness({ ls: unreachable })
    assert.equal(await run(argv('ls'), deps), 1)
    assert.match(err[0] ?? '', /that fleet is not running; fleet up squad starts it/)
  })

  it('renders the fleet and the decisions waiting on the user', async () => {
    const { deps, out, calls, sockets } = harness({ ls: () => listing })
    assert.equal(await run(argv('ls'), deps), 0)
    assert.deepEqual(sockets, [socketPath], 'the profile\'s socket, derived from ~/.fleet/<profile>')
    assert.deepEqual(calls, [{ method: 'ls', params: {} }])
    const text = out[0] ?? ''
    assert.match(text, /squad {2}pid 4242/)
    assert.match(text, /peers \(1\)/)
    assert.match(text, /engineer-1 {2}engineer {2}claude\/test-small {2}working {2}brief v2 {2}ses_0123456789abcdef/)
    assert.match(text, /routines \(1\)/)
    assert.match(text, /decisions \(1\)/)
    assert.match(text, /Which repo does the checkout belong to\?/)
    assert.match(text, /options: me-services \| other/)
    assert.match(text, /answer: fleet decide dec_0123456789abcdef <option>/)
    // The fleet-wide count is in the heading, so a fleet whose peers are all
    // quietly compacting says so in one number rather than in rows nobody reads.
    assert.match(text, /compactions \(2 total\) \(1\)/)
    assert.match(text, /engineer-1 {2}2x {2}last manual {2}pre 90000/)
    // Spend is shown per Work and rolled up per peer; the heading is the fleet
    // total, taken from the rollups so no Work's cost is counted twice (§6.2).
    assert.match(text, /tokens \(\$4\.12 total\) \(2\)/)
    assert.match(text, /engineer-1 +engineer +all +12 turns +in 12000 +out 3000 +cached 900 +\$4\.12/)
    assert.match(text, /engineer-1 +engineer +wrk_7f3a91c2d84b0e56 +8 turns +in 9000 +out 2000 +cached 600 +\$3\.01/)
    // A peer that says `working` is a peer whose reader wants to know at what:
    // tool, target, Work and how much of that Work it has rewritten (§4).
    assert.match(text, /activity \(1\)/)
    assert.match(
      text,
      /engineer-1 {2}Edit {2}packages\/foundation\/store\/src\/projections\.ts {2}wrk_0123456789abcdef {2}edits 14 {2}\d{4}-\d\d-\d\dT/,
    )
  })

  it('says so in each section that is empty rather than printing a bare heading', async () => {
    const empty: LsResult = { status, peers: [], routines: [], decisions: [], compactions: [], tokens: [], activity: [] }
    const { deps, out } = harness({ ls: () => empty })
    assert.equal(await run(argv('ls'), deps), 0)
    assert.match(out[0] ?? '', /none registered/)
    assert.match(out[0] ?? '', /none: no peer has a Work or has used a tool/)
    assert.match(out[0] ?? '', /none: no peer has compacted/)
    assert.match(out[0] ?? '', /nothing waiting on the user/)
  })

  it('prints the daemon\'s answer untouched under --json', async () => {
    const { deps, out } = harness({ ls: () => listing })
    assert.equal(await run(argv('ls', '--json'), deps), 0)
    assert.deepEqual(JSON.parse(out[0] ?? ''), listing)
  })

  it('accepts profile as a positional argument for consistency with up/down', async () => {
    const { deps, out, sockets } = harness({ ls: () => listing })
    assert.equal(await run(argv('ls', 'other-fleet'), deps), 0)
    assert.match(out[0] ?? '', /squad/)
    assert.match(sockets[0] ?? '', /\/other-fleet\//)
  })

  it('accepts profile as --profile flag', async () => {
    const { deps, out, sockets } = harness({ ls: () => listing })
    assert.equal(await run(argv('ls', '--profile', 'other-fleet'), deps), 0)
    assert.match(out[0] ?? '', /squad/)
    assert.match(sockets[0] ?? '', /\/other-fleet\//)
  })
})

describe('run: send', () => {
  it('joins the body back together and sends one message', async () => {
    const { deps, out, calls } = harness({ send: () => ({ msgId: 'msg_0123456789abcdef' }) })
    assert.equal(await run(argv('send', 'engineer-1', 'info', 'look', 'at', 'the PR'), deps), 0)
    assert.deepEqual(calls, [
      { method: 'send', params: { to: 'engineer-1', kind: 'info', body: 'look at the PR' } },
    ])
    assert.equal(out[0], 'sent msg_0123456789abcdef to engineer-1')
  })

  it('says who it is from when FLEET_PEER is set, so a peer\'s mail is attributed to it (§8)', async () => {
    const { deps, calls } = harness(
      { send: () => ({ msgId: 'msg_0123456789abcdef' }) },
      { env: { FLEET_PROFILE: 'squad', FLEET_PEER: 'architect' } },
    )
    assert.equal(await run(argv('send', 'engineer-1', 'info', 'hi'), deps), 0)
    assert.deepEqual(calls, [
      { method: 'send', params: { to: 'engineer-1', kind: 'info', body: 'hi', from: 'architect' } },
    ])
  })

  it('refuses a FLEET_PEER that is not a peer id rather than sending it on', async () => {
    const { deps, err, calls } = harness({}, { env: { FLEET_PROFILE: 'squad', FLEET_PEER: '../etc' } })
    assert.equal(await run(argv('send', 'engineer-1', 'info', 'hi'), deps), 2)
    assert.match(err[0] ?? '', /FLEET_PEER/)
    assert.deepEqual(calls, [])
  })

  it('refuses a kind that is not one of §7\'s four', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('send', 'engineer-1', 'shout', 'hi'), deps), 2)
    assert.match(err[0] ?? '', /kind "shout" is not one of brief, answer, nudge, info/)
    assert.deepEqual(calls, [])
  })

  it('refuses a message with no body', async () => {
    const { deps, err } = harness({})
    assert.equal(await run(argv('send', 'engineer-1', 'info'), deps), 2)
    assert.match(err[0] ?? '', /usage: fleet send/)
  })

  it('ends a command with no arguments at the command, with no dangling space', async () => {
    const { deps, err } = harness({})
    assert.equal(await run(argv('ls', 'profile1', 'profile2'), deps), 2)
    assert.match(err[0] ?? '', /usage: fleet ls/)
  })

  it('refuses a peer id the contract would refuse, without a round trip', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('send', '../etc', 'info', 'hi'), deps), 2)
    assert.match(err[0] ?? '', /peer: expected/)
    assert.deepEqual(calls, [])
  })
})

describe('run: note', () => {
  it('notes on the Work the caller holds, naming the peer from FLEET_PEER', async () => {
    const { deps, out, calls } = harness(
      { note: () => ({ workId: 'wrk_7f3a91c2d84b0e56', phase: 'implement' }) },
      { env: { FLEET_PROFILE: 'squad', FLEET_PEER: 'engineer-1' } },
    )
    assert.equal(await run(argv('note', 'implement', 'the', 'checks', 'verdict', 'is', 'pinned'), deps), 0)
    // A peer names no workId: the daemon reads it off the assignee (§5.1).
    assert.deepEqual(calls, [
      { method: 'note', params: { peerId: 'engineer-1', phase: 'implement', body: 'the checks verdict is pinned' } },
    ])
    assert.match(out[0] ?? '', /noted implement on wrk_7f3a91c2d84b0e56/)
  })

  it('refuses a phase outside the closed list, naming the four that exist', async () => {
    const { deps, err, calls } = harness({}, { env: { FLEET_PROFILE: 'squad', FLEET_PEER: 'engineer-1' } })
    assert.equal(await run(argv('note', 'done', 'finished it'), deps), 2)
    assert.match(err[0] ?? '', /phase "done" is not one of plan, implement, mr, blocked/)
    assert.deepEqual(calls, [])
  })

  it('refuses to guess whose note it is when the shell was not started by the fleet', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('note', 'plan', 'read the design'), deps), 2)
    assert.match(err[0] ?? '', /FLEET_PEER is not set/)
    assert.deepEqual(calls, [])
  })
})

describe('run: peek', () => {
  it('asks for the peer\'s last N messages when told to', async () => {
    const { deps, out, calls } = harness({ peek: () => ({ messages: [] }) })
    assert.equal(await run(argv('peek', 'engineer-1', '--limit', '2'), deps), 0)
    assert.deepEqual(calls, [{ method: 'peek', params: { peer: 'engineer-1', limit: 2 } }])
    assert.equal(out[0], 'engineer-1: no messages')
  })

  it('refuses a limit that is not a positive whole number', async () => {
    for (const limit of ['0', '-1', '2.5', 'lots']) {
      const { deps, err } = harness({})
      assert.equal(await run(argv('peek', 'engineer-1', '--limit', limit), deps), 2, limit)
      assert.match(err[0] ?? '', /--limit takes a positive whole number/)
    }
  })
})

describe('run: decide', () => {
  it('answers an open decision with the option the user named', async () => {
    const answered = { ...decision, state: 'answered' as const, option: 'me-services', answeredAt: now }
    const { deps, out, calls } = harness({ decide: () => answered })
    assert.equal(await run(argv('decide', 'dec_0123456789abcdef', 'me-services'), deps), 0)
    assert.deepEqual(calls, [
      { method: 'decide', params: { id: 'dec_0123456789abcdef', decision: 'me-services' } },
    ])
    assert.match(out[0] ?? '', /answered: me-services/)
  })

  it('carries a free-text note through', async () => {
    const { deps, calls } = harness({ decide: () => ({ ...decision, state: 'answered' as const, text: 'x' }) })
    await run(argv('decide', 'dec_0123456789abcdef', 'other', '--note', 'because the layout'), deps)
    assert.deepEqual(calls[0]?.params, {
      id: 'dec_0123456789abcdef',
      decision: 'other',
      note: 'because the layout',
    })
  })

  it('shows the decision, from the inbox, when no answer is given', async () => {
    const { deps, out, calls } = harness({ ls: () => listing })
    assert.equal(await run(argv('decide', 'dec_0123456789abcdef'), deps), 0)
    assert.deepEqual(
      calls.map((call) => call.method),
      ['ls'],
      'showing a decision is a question about the inbox, not a seventh method',
    )
    assert.match(out[0] ?? '', /route_question {2}open {2}Which repo/)
  })

  it('says not_found for a decision that is not in the inbox', async () => {
    const { deps, err } = harness({ ls: () => listing })
    assert.equal(await run(argv('decide', 'dec_ffffffffffffffff'), deps), 1)
    assert.match(err[0] ?? '', /no decision dec_ffffffffffffffff/)
  })
})

const evalRun = (runId: string, passed: number): EvalRunWithCases => ({
  run: {
    runId: runId as EvalRunId,
    suite: 'judge',
    sha: 'ffcd0091a2b3c4d5' as Sha,
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V3.2',
    cases: 20,
    state: 'finished',
    passed,
    startedAt: now,
    finishedAt: now,
  },
  cases: [
    { runId: runId as EvalRunId, caseId: 'stacked-merge-branch-loss', attempts: 3, passes: 3, pass: true, score: 1, detail: 'ok', updatedAt: now },
  ],
})

describe('run: evals compare', () => {
  it('reads both runs by id and puts them side by side', async () => {
    const before = evalRun('evr_1111111111111111', 18)
    const after = evalRun('evr_2222222222222222', 20)
    const { deps, out, calls } = harness({ evals: (params) => ((params as { runId: string }).runId === before.run.runId ? before : after) })
    assert.equal(await run(argv('evals', 'compare', before.run.runId, after.run.runId), deps), 0)
    assert.deepEqual(calls, [
      { method: 'evals', params: { runId: before.run.runId } },
      { method: 'evals', params: { runId: after.run.runId } },
    ])
    assert.match(out[0] ?? '', /18 of 20 cases passed/)
    assert.match(out[0] ?? '', /\+2 cases/)
  })

  it('refuses a run id the contract would refuse, without a round trip', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('evals', 'compare', 'judge', 'evr_2222222222222222'), deps), 2)
    assert.match(err[0] ?? '', /run id: expected/)
    assert.deepEqual(calls, [])
  })

  it('a verb that is neither run nor compare names both', async () => {
    const { deps, err } = harness({})
    assert.equal(await run(argv('evals', 'diff', 'a', 'b'), deps), 2)
    assert.match(err[0] ?? '', /usage: fleet evals run <suite> \| fleet evals compare <runA> <runB>/)
  })

  it('--json prints both runs as the daemon answered them', async () => {
    const before = evalRun('evr_1111111111111111', 18)
    const { deps, out } = harness({ evals: () => before })
    await run(argv('evals', 'compare', before.run.runId, before.run.runId, '--json'), deps)
    assert.deepEqual(JSON.parse(out[0] ?? '{}'), { a: before, b: before })
  })

  it('reports a run the log does not have as not_found, and exits 1', async () => {
    const missing = new FleetError('not_found', 'no eval run evr_1111111111111111')
    const { deps, err } = harness({
      evals: (params) => {
        if ((params as { runId: string }).runId === 'evr_1111111111111111') throw missing
        return evalRun('evr_2222222222222222', 20)
      },
    })
    assert.equal(await run(argv('evals', 'compare', 'evr_1111111111111111', 'evr_2222222222222222'), deps), 1)
    assert.match(err[0] ?? '', /no eval run/)
  })
})

describe('run: down', () => {  it('reports the daemon stopped', async () => {
    const { deps, out } = harness({ down: () => ({ stopped: true }) })
    assert.equal(await run(argv('down'), deps), 0)
    assert.equal(out[0], 'fleetd stopped')
  })

  it('treats a fleet that is already down as stopped, not as a failure', async () => {
    const { deps, out, err } = harness({ down: unreachable })
    assert.equal(await run(argv('down'), deps), 0)
    assert.equal(out[0], 'squad is not running')
    assert.deepEqual(err, [])
  })

  it('accepts profile as a positional argument for consistency with up/ls', async () => {
    const { deps, out, sockets } = harness({ down: () => ({ stopped: true }) })
    assert.equal(await run(argv('down', 'other-fleet'), deps), 0)
    assert.equal(out[0], 'fleetd stopped')
    assert.match(sockets[0] ?? '', /\/other-fleet\//)
  })

  it('accepts profile as --profile flag', async () => {
    const { deps, out, sockets } = harness({ down: () => ({ stopped: true }) })
    assert.equal(await run(argv('down', '--profile', 'other-fleet'), deps), 0)
    assert.equal(out[0], 'fleetd stopped')
    assert.match(sockets[0] ?? '', /\/other-fleet\//)
  })
})

describe('run: a profile that is not there', () => {
  it('names the file, and never reaches the daemon', async () => {
    const { deps, err, calls } = harness({}, { profileFileExists: () => false })
    assert.equal(await run(argv('ls'), deps), 2)
    assert.match(err[0] ?? '', /no profile "squad": \/home\/tester\/\.config\/fleet\/profiles\/squad\.yaml is not there/)
    assert.deepEqual(calls, [])
  })

  it('does not second-guess an explicit socket, which names a daemon and no profile file', async () => {
    const { deps, out } = harness({ ls: () => listing }, { profileFileExists: () => false })
    assert.equal(await run(argv('ls', '--socket', '/tmp/elsewhere.sock'), deps), 0)
    assert.match(out[0] ?? '', /squad/)
  })
})

describe('run: evals run', () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const repo = 'backbase/me-services-fleet'
  /** All four options a run needs, in the order a person types them. */
  const judge = (...extra: readonly string[]): readonly string[] =>
    argv('evals', 'run', 'judge', '--provider', 'deepinfra', '--model', 'a-model', '--repo', repo, '--sha', sha, ...extra)

  /** The suite's stdout: one object, of the shape `packages/evals/suites/judge` writes. */
  const evalAnswer = (gate: unknown, over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      runId: 'evr_0123456789abcdef',
      report: {
        suite: 'judge',
        provider: 'deepinfra',
        model: 'a-model',
        sha: 'a1b2c3d4e5f6',
        cases: 2,
        passed: 1,
        tokens: { input: 0, output: 0 },
        latencyMs: [10, 20],
        retries: 0,
      },
      gate,
      events: {
        started: { type: 'eval.run_started', ts: now, subject: 'evr_0123456789abcdef', actor: 'scheduler', data: {} },
        scored: [
          { type: 'eval.case_scored', ts: now, subject: 'evr_0123456789abcdef', actor: 'scheduler', data: {} },
          { type: 'eval.case_scored', ts: now, subject: 'evr_0123456789abcdef', actor: 'scheduler', data: {} },
        ],
        finished: { type: 'eval.run_finished', ts: now, subject: 'evr_0123456789abcdef', actor: 'scheduler', data: {} },
      },
      ...over,
    })

  /** The build row the ledger answers with, and the answer file it left beside the log. */
  const built = async (
    body: string | undefined,
    over: Partial<BuildsResult['build']> = {},
    deduped = false,
  ): Promise<BuildsResult> => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-cli-evals-'))
    const logPath = join(dir, `${sha}-evals-judge-deepinfra-a-model.log`)
    if (body !== undefined) await writeFile(buildStdoutPath(logPath), body)
    return {
      build: {
        buildId: 'bld_0123456789abcdef',
        repo: repo as Repo,
        sha: sha as Sha,
        task: 'evals:judge:deepinfra:a-model',
        host: 'remote',
        status: 'succeeded',
        logPath,
        durationMs: 4200,
        startedAt: now,
        finishedAt: now,
        ...over,
      },
      deduped,
    }
  }

  /** A harness with the daemon answering `builds` and `events.append`. */
  const evals = (result: BuildsResult, over: Partial<RunDeps> = {}): Harness =>
    harness(
      {
        builds: () => result,
        'events.append': (params) => ({ seqs: (params as { events: unknown[] }).events.map((_, i) => i + 1) }),
      },
      over,
    )

  it('asks the ledger for the run, and prints the answer it finds beside the log', async () => {
    const { deps, calls, out, err } = evals(await built(evalAnswer({ kind: 'pass', exitCode: 0 })))
    assert.equal(await run(judge(), deps), 0)
    assert.deepEqual(calls[0], {
      method: 'builds',
      params: {
        repo,
        sha,
        task: 'evals:judge:deepinfra:a-model',
        command: {
          bin: 'fleet-evals-judge',
          args: [],
          // Only the two variables the suite reads: the rest of this process's
          // environment is not the ledger's business, and it would be exported on
          // the remote host.
          env: { FLEET_EVAL_PROVIDER: 'deepinfra', FLEET_EVAL_MODEL: 'a-model' },
        },
      },
    })
    const text = out[0] ?? ''
    assert.match(text, /judge: deepinfra\/a-model at a1b2c3d/)
    assert.match(text, /1 of 2 cases passed/)
    assert.match(text, /cost {6}n\/a \(the provider does not report it\)/)
    assert.deepEqual(err, [])
  })

  it('passes --save-baseline through to the build', async () => {
    const { deps, calls } = evals(await built(evalAnswer({ kind: 'saved', exitCode: 0 })))
    assert.equal(await run(judge('--save-baseline'), deps), 0)
    assert.deepEqual((calls[0]?.params as { command: { args: string[] } }).command.args, ['--save-baseline'])
  })

  it('files a --save-baseline run under its own build task, so a plain run of the same identity cannot dedupe it away (TASK-35)', async () => {
    const plain = evals(await built(evalAnswer({ kind: 'pass', exitCode: 0 })))
    assert.equal(await run(judge(), plain.deps), 0)
    const saving = evals(await built(evalAnswer({ kind: 'saved', exitCode: 0 })))
    assert.equal(await run(judge('--save-baseline'), saving.deps), 0)

    const taskOf = (calls: readonly { params?: unknown }[]) => (calls[0]?.params as { task: string }).task
    assert.notEqual(taskOf(saving.calls), taskOf(plain.calls), 'the ledger keys on (repo, sha, task)')
  })

  it('sends the rows through events.append in the two batches the citation rule asks for', async () => {
    const { deps, calls } = evals(await built(evalAnswer({ kind: 'pass', exitCode: 0 })))
    assert.equal(await run(judge(), deps), 0)
    assert.deepEqual(
      calls.map((c) => c.method),
      ['builds', 'events.append', 'events.append'],
    )
    const [start, rest] = calls
      .slice(1)
      .map((c) => (c.params as { events: { type: string; causedBy?: number[] }[] }).events)
    assert.deepEqual(
      start?.map((e) => e.type),
      ['eval.run_started'],
    )
    assert.deepEqual(
      rest?.map((e) => e.type),
      ['eval.case_scored', 'eval.case_scored', 'eval.run_finished'],
    )
    // every row after the start cites it, which is how a reader joins the run
    assert.deepEqual(
      rest?.map((e) => e.causedBy),
      [[1], [1], [1]],
    )
    assert.equal(start?.[0]?.causedBy, undefined)
  })

  it("exits with the run's own code when it fell below its baseline", async () => {
    const gate = {
      kind: 'regressed',
      exitCode: 1,
      regressions: [{ caseId: 'case-b', passes: 1, attempts: 3, baselinePasses: 3, baselineAttempts: 3 }],
    }
    const { deps, out } = evals(await built(evalAnswer(gate)))
    assert.equal(await run(judge(), deps), 1)
    assert.match(out[0] ?? '', /below the baseline:/)
    assert.match(out[0] ?? '', /case-b: 1\/3 attempts, baseline 3\/3/)
  })

  it('says there is no baseline yet, and passes, on a first run', async () => {
    const { deps, out } = evals(await built(evalAnswer({ kind: 'no-baseline', exitCode: 0 })))
    assert.equal(await run(judge(), deps), 0)
    assert.match(out[0] ?? '', /no baseline yet; run with --save-baseline/)
  })

  it('reports where the baseline went when it was asked to save one', async () => {
    const { deps, out } = evals(
      await built(evalAnswer({ kind: 'saved', exitCode: 0 }, { baselinePath: 'tests/evals/baselines/judge.json' })),
    )
    assert.equal(await run(judge('--save-baseline'), deps), 0)
    assert.match(out[0] ?? '', /baseline written to tests\/evals\/baselines\/judge\.json/)
  })

  it("says an identical run was reused, because the numbers are an older run's", async () => {
    const { deps, out } = evals(await built(evalAnswer({ kind: 'pass', exitCode: 0 }), {}, true))
    assert.equal(await run(judge(), deps), 0)
    assert.match(out[0] ?? '', /reused: evals:judge:deepinfra:a-model at a1b2c3d4e5f6 had already run/)
  })

  it('exits 2 when the build did not finish, naming the log and appending nothing', async () => {
    const { deps, out, err, calls } = evals(await built(undefined, { status: 'failed' }))
    assert.equal(await run(judge(), deps), 2)
    // The log is the whole account of a run that never printed an answer.
    assert.match(err.join('\n'), /did not finish \(failed\)/)
    assert.match(out[0] ?? '', /log .*evals-judge-deepinfra-a-model\.log/)
    assert.deepEqual(
      calls.map((c) => c.method),
      ['builds'],
    )
  })

  it('exits 2 when the build finished but left no answer to read', async () => {
    const { deps, err } = evals(await built(undefined))
    assert.equal(await run(judge(), deps), 2)
    assert.match(err.join('\n'), /left no answer in .*\.out/)
  })

  it('keeps the answer when the ledger refuses the rows', async () => {
    const { deps, out, err } = evals(await built(evalAnswer({ kind: 'pass', exitCode: 0 })))
    const withRefusal: RunDeps = {
      ...deps,
      call: (socket: string) => {
        const inner = deps.call(socket) as unknown as (method: DaemonMethod, params: unknown) => Promise<unknown>
        return ((method: DaemonMethod, params: unknown) =>
          method === 'events.append'
            ? Promise.reject(new FleetError('store_failed', 'the store is at its row limit'))
            : inner(method, params)) as unknown as DaemonCaller
      },
    }
    // the answer still prints, and the run's code still decides the exit: losing a
    // ledger row is a fleet problem, not a verdict on the model
    assert.equal(await run(judge(), withRefusal), 0)
    assert.match(out[0] ?? '', /1 of 2 cases passed/)
    assert.match(err.join('\n'), /did not reach the ledger: the store is at its row limit/)
  })

  it('refuses a run that does not name all five parts of its identity', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('evals', 'run', 'judge'), deps), 2)
    // A default for any of them would be a *different* key: a second row for the same
    // work, or an older row's answer for something it never measured.
    assert.match(err.join('\n'), /--provider <name>, --model <id>, --repo <owner\/name>, --sha <sha>/)
    assert.deepEqual(calls, [])
  })

  it('refuses a suite with no runner, and a `evals` with no subcommand', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('evals'), deps), 2)
    assert.equal(await run(argv('evals', 'run', 'briefs'), deps), 2)
    assert.equal(await run(argv('evals', 'run', 'nonsense'), deps), 2)
    assert.equal(await run(argv('evals', 'run'), deps), 2)
    const said = err.join('\n')
    assert.match(said, /usage: fleet evals run <suite>/)
    assert.match(said, /the briefs suite has no runner yet; judge is the one that runs/)
    assert.match(said, /suite "nonsense" is not one of judge, briefs/)
    assert.deepEqual(calls, [])
  })
})

describe('run: up', () => {
  it('attaches to a daemon that is already up, and starts nothing', async () => {
    const { deps, out, started } = harness({ up: () => status })
    assert.equal(await run(argv('up', 'squad'), deps), 0)
    assert.deepEqual(started, [])
    assert.match(out[0] ?? '', /squad up, pid 4242/)
  })

  it('says what it started despite, after the addresses it gives (TASK-12)', async () => {
    // The fleet is up: a warning is not a failure, so it comes after the socket
    // and the store rather than replacing them, and it names the peer — the one
    // thing a person can go and change in the profile.
    const warned = { ...status, warnings: ["peer 'reviewer-1' asks for effort 'high', but provider 'cursor' cannot honour it"] }
    const { deps, out } = harness({ up: () => warned })
    assert.equal(await run(argv('up', 'squad'), deps), 0)
    assert.match(out[0] ?? '', /^squad up, pid 4242\nsocket .*\nstore .*\nwarn {4}peer 'reviewer-1' asks for effort 'high'/)
  })

  it('starts fleetd when the socket is dead, then waits for it to answer', async () => {
    let attempts = 0
    const { deps, out, started } = harness({
      up: () => {
        attempts += 1
        if (attempts === 1) unreachable()
        return status
      },
    })
    assert.equal(await run(argv('up', 'squad'), deps), 0)
    assert.deepEqual(started, ['squad'])
    assert.equal(attempts, 2)
    assert.match(out[0] ?? '', /squad up, pid 4242/)
  })

  it('gives up when fleetd never answers, and says where its log is', async () => {
    const { deps, err } = harness({ up: unreachable }, { upTimeoutMs: 0 })
    assert.equal(await run(argv('up', 'squad'), deps), 1)
    assert.match(err[0] ?? '', /fleetd did not come up within 0 ms; the daemon's own output is in \/home\/tester\/\.fleet\/squad\/daemon\/fleetd\.log/)
  })

  it('will not start a daemon it has no profile for, but says how to give it one', async () => {
    const { deps, err, started } = harness({ up: unreachable })
    assert.equal(await run(argv('up', '--socket', '/tmp/x.sock'), deps), 1)
    assert.deepEqual(started, [])
    assert.match(err[0] ?? '', /name a profile \(fleet up <profile>\)/)
  })

  it('does not start a daemon over a refusal: only an unreachable socket means "not running"', async () => {
    const { deps, err, started } = harness({
      up: () => {
        throw new FleetError('store_failed', 'the store will not open')
      },
    })
    assert.equal(await run(argv('up', 'squad'), deps), 1)
    assert.deepEqual(started, [])
    assert.match(err[0] ?? '', /the store will not open/)
  })
})

describe('run: replay', () => {
  const event = (seq: number, type: string) => ({
    seq,
    ts: now,
    type,
    subject: 'engineer-1',
    actor: 'pm',
    causedBy: [],
    data: {},
  })

  it('rebuilds the projections when asked for no window, and prints what it replayed', async () => {
    const { deps, out, calls } = harness({ replay: () => ({ mode: 'rebuild', events: 12, latestSeq: 12 }) })
    assert.equal(await run(argv('replay'), deps), 0)
    assert.deepEqual(calls, [{ method: 'replay', params: {} }])
    assert.match(out[0] ?? '', /rebuilt every projection from 12 event\(s\); the log is at seq 12/)
  })

  it('reads a window when given --from and --to, and prints the events oldest first', async () => {
    const { deps, out, calls } = harness({
      replay: () => ({ mode: 'window', events: [event(3, 'peer.registered'), event(4, 'message.sent')] }),
    })
    assert.equal(await run(argv('replay', '--from', '3', '--to', '4'), deps), 0)
    assert.deepEqual(calls, [{ method: 'replay', params: { from: 3, to: 4 } }])
    const lines = (out[0] ?? '').split('\n')
    assert.equal(lines[0], '2 event(s)')
    assert.match(lines[1] ?? '', /^  3 {2}.*peer\.registered/)
    assert.match(lines[2] ?? '', /^  4 {2}.*message\.sent/)
  })

  it('sends only --from when no --to was given, so the daemon reads to the head', async () => {
    const { deps, calls } = harness({ replay: () => ({ mode: 'window', events: [] }) })
    assert.equal(await run(argv('replay', '--from', '7'), deps), 0)
    assert.deepEqual(calls, [{ method: 'replay', params: { from: 7 } }])
  })

  it('says so when the window holds nothing', async () => {
    const { deps, out } = harness({ replay: () => ({ mode: 'window', events: [] }) })
    assert.equal(await run(argv('replay', '--from', '99', '--to', '120'), deps), 0)
    assert.equal(out[0], 'no events in that window')
  })

  it('refuses --to without --from before reaching the daemon', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('replay', '--to', '9'), deps), 2)
    assert.match(err[0] ?? '', /--to needs a --from/)
    assert.deepEqual(calls, [])
  })

  it('refuses a window that runs backwards', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('replay', '--from', '9', '--to', '3'), deps), 2)
    assert.match(err[0] ?? '', /is before --from 9/)
    assert.deepEqual(calls, [])
  })

  it('refuses a seq that is not a whole number', async () => {
    const { deps, err } = harness({})
    assert.equal(await run(argv('replay', '--from', '0'), deps), 2)
    assert.match(err[0] ?? '', /--from takes a positive whole number/)
  })

  it('prints the daemon answer untouched under --json', async () => {
    const { deps, out } = harness({ replay: () => ({ mode: 'rebuild', events: 2, latestSeq: 2 }) })
    assert.equal(await run(argv('replay', '--json'), deps), 0)
    assert.deepEqual(JSON.parse(out[0] ?? ''), { mode: 'rebuild', events: 2, latestSeq: 2 })
  })
})

describe('run: build', () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const built: BuildsResult = {
    build: {
      buildId: 'bld_0123456789abcdef',
      repo: 'backbase/me-services-fleet' as Repo,
      sha: sha as Sha,
      task: 'evals:judge:deepinfra:a-model',
      host: 'remote',
      status: 'succeeded',
      logPath: `/home/tester/.fleet/squad/artifacts/builds/${sha}/evals-judge.deepinfra.a-model.log`,
      durationMs: 4200,
      startedAt: now,
      finishedAt: now,
    },
    deduped: false,
  }

  it('passes everything after "--" through untouched, flags and all', async () => {
    const { deps, calls } = harness({ builds: () => built })
    const code = await run(
      argv('build', built.build.task, sha, '--repo', 'backbase/me-services-fleet', '--', 'pnpm', 'test', '--filter', '-c'),
      deps,
    )
    assert.equal(code, 0)
    assert.deepEqual(calls, [
      {
        method: 'builds',
        params: {
          repo: 'backbase/me-services-fleet',
          sha,
          task: built.build.task,
          command: { bin: 'pnpm', args: ['test', '--filter', '-c'] },
        },
      },
    ])
  })

  it('says a triple that already ran was reused rather than run again', async () => {
    const { deps, out } = harness({ builds: () => ({ ...built, deduped: true }) })
    assert.equal(await run(argv('build', built.build.task, sha, '--repo', 'backbase/me-services-fleet', '--', 'pnpm', 'test'), deps), 0)
    assert.match(out[0] ?? '', /reused: this triple had already run/)
    assert.match(out[0] ?? '', new RegExp(`log\\s+.*${sha}.*\\.log`))
    assert.match(out[0] ?? '', /took {2}4200ms/)
  })

  it('refuses a build with no repo, since the key would be a different one', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('build', 'evals:judge:x:y', sha, '--', 'pnpm', 'test'), deps), 2)
    assert.match(err[0] ?? '', /needs --repo <owner\/name>/)
    assert.deepEqual(calls, [])
  })

  it('refuses a build with nothing to run', async () => {
    const { deps, err, calls } = harness({})
    const code = await run(argv('build', 'evals:judge:x:y', sha, '--repo', 'backbase/me-services-fleet', '--'), deps)
    assert.equal(code, 2)
    assert.match(err[0] ?? '', /needs a command after "--"/)
    assert.deepEqual(calls, [])
  })

  it('refuses "--" on a command that has no command of its own', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('ls', '--', 'echo', 'hi'), deps), 2)
    assert.match(err[0] ?? '', /only `fleet build` takes a command after "--"/)
    assert.deepEqual(calls, [])
  })

  it('refuses a sha the contract would refuse, without a round trip', async () => {
    const { deps, err, calls } = harness({})
    const code = await run(argv('build', 'evals:judge:x:y', 'not-a-sha', '--repo', 'backbase/me-services-fleet', '--', 'pnpm'), deps)
    assert.equal(code, 2)
    assert.match(err[0] ?? '', /sha: expected/)
    assert.deepEqual(calls, [])
  })

  it('send body can contain words starting with - (e.g., "-1" or "-fix")', async () => {
    const { deps, out, calls } = harness({ send: () => ({ msgId: 'msg_0123456789abcdef' }) })
    const code = await run(argv('send', 'engineer-1', 'info', '-fix', 'the', 'build'), deps)
    assert.equal(code, 0)
    assert.deepEqual(calls, [
      { method: 'send', params: { to: 'engineer-1', kind: 'info', body: '-fix the build' } },
    ])
  })

  it('send body can contain --option-like words', async () => {
    const { deps, out, calls } = harness({ send: () => ({ msgId: 'msg_0123456789abcdef' }) })
    const code = await run(argv('send', 'engineer-1', 'info', '--help', 'me'), deps)
    assert.equal(code, 0)
    assert.deepEqual(calls, [
      { method: 'send', params: { to: 'engineer-1', kind: 'info', body: '--help me' } },
    ])
  })

  it('decide answer can contain words starting with - (e.g., "-1")', async () => {
    const { deps, out, calls } = harness({ decide: () => ({ options: [] }) })
    const code = await run(argv('decide', 'dec_0123456789abcdef', '-1'), deps)
    assert.equal(code, 0)
    assert.deepEqual(calls, [
      { method: 'decide', params: { id: 'dec_0123456789abcdef', decision: '-1' } },
    ])
  })

  it('decide answer can contain --option-like words', async () => {
    const { deps, out, calls } = harness({ decide: () => ({ options: [] }) })
    const code = await run(argv('decide', 'dec_0123456789abcdef', '--help', 'option'), deps)
    assert.equal(code, 0)
    assert.deepEqual(calls, [
      { method: 'decide', params: { id: 'dec_0123456789abcdef', decision: '--help option' } },
    ])
  })
})
