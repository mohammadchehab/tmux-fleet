import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FleetError, type DecisionId, type PeerId, type SessionId } from '@fleet/foundation-core'
import type { DaemonMethod, LsResult } from '@fleet/foundation-contracts'
import type { DaemonCaller } from '../src/client.ts'
import { run, type RunDeps } from '../src/run.ts'

const now = '2026-11-10T09:00:00.000Z'
const socketPath = '/home/tester/.fleet/squad/daemon/fleetd.sock'

const status = { profile: 'squad', pid: 4242, startedAt: now, socketPath: '/home/tester/.fleet/squad/daemon/fleetd.sock', storePath: '/home/tester/.fleet/squad/store/store.sqlite' }

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

const listing: LsResult = { status, peers: [peer], routines: [routine], decisions: [decision] }

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
    sleep: () => Promise.resolve(),
    ...overrides,
  }
  return { deps, calls, out, err, started, sockets }
}

const argv = (...words: readonly string[]): readonly string[] => ['node', 'fleet', ...words]

const unreachable = (): never => {
  throw new FleetError('external_failed', `cannot reach fleetd at ${socketPath}: connect ENOENT`)
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
  })

  it('says so in each section that is empty rather than printing a bare heading', async () => {
    const empty: LsResult = { status, peers: [], routines: [], decisions: [] }
    const { deps, out } = harness({ ls: () => empty })
    assert.equal(await run(argv('ls'), deps), 0)
    assert.match(out[0] ?? '', /none registered/)
    assert.match(out[0] ?? '', /nothing waiting on the user/)
  })

  it('prints the daemon\'s answer untouched under --json', async () => {
    const { deps, out } = harness({ ls: () => listing })
    assert.equal(await run(argv('ls', '--json'), deps), 0)
    assert.deepEqual(JSON.parse(out[0] ?? ''), listing)
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

  it('refuses a peer id the contract would refuse, without a round trip', async () => {
    const { deps, err, calls } = harness({})
    assert.equal(await run(argv('send', '../etc', 'info', 'hi'), deps), 2)
    assert.match(err[0] ?? '', /peer: expected/)
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

describe('run: down', () => {
  it('reports the daemon stopped', async () => {
    const { deps, out } = harness({ down: () => ({ stopped: true }) })
    assert.equal(await run(argv('down'), deps), 0)
    assert.equal(out[0], 'fleetd stopped')
  })
})

describe('run: up', () => {
  it('attaches to a daemon that is already up, and starts nothing', async () => {
    const { deps, out, started } = harness({ up: () => status })
    assert.equal(await run(argv('up', 'squad'), deps), 0)
    assert.deepEqual(started, [])
    assert.match(out[0] ?? '', /squad up, pid 4242/)
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
    assert.match(err[0] ?? '', /fleetd did not come up within 0 ms; see ~\/.fleet\/<profile>\/daemon\/fleetd\.log/)
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
