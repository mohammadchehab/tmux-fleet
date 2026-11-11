/**
 * `fleet attach`, `release`, `stop`, `start` (watch-and-attach §5, §7.2): what
 * the CLI asks the daemon, what it runs, and that a peer always goes back.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { DaemonMethod } from '@fleet/foundation-contracts'

import type { DaemonCaller } from '../src/client.ts'
import { attachBanner, run, type RunDeps } from '../src/run.ts'
import { takeoverEnv, type Takeover } from '../src/takeover.ts'

const ref = '1d61f8ce-5fe5-45cf-8273-3f06cab62c86'
const held = {
  peerId: 'engineer-1',
  providerId: 'claude',
  sessionRef: ref,
  cwd: '/work/engineer-1',
  model: 'claude-opus-5-5',
  env: { FLEET_PEER: 'engineer-1', ANTHROPIC_BASE_URL: 'https://endpoint.example', PATH: '/daemon/bin' },
  command: { executable: 'claude', args: ['--resume', ref, '--model', 'claude-opus-5-5'] },
  pendingMessages: 2,
}

const harness = (
  answers: Partial<Record<DaemonMethod, (params: unknown) => unknown>>,
  takeover?: Takeover,
  env: Record<string, string> = { FLEET_PROFILE: 'squad', TERM: 'xterm-256color', PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://stale.example' },
) => {
  const calls: { method: DaemonMethod; params: unknown }[] = []
  const out: string[] = []
  const err: string[] = []
  const call = (() =>
    ((method: DaemonMethod, params: unknown) => {
      calls.push({ method, params })
      const answer = answers[method]
      if (answer === undefined) return Promise.reject(new Error(`no answer for ${method}`))
      try {
        return Promise.resolve(answer(params))
      } catch (thrown) {
        return Promise.reject(thrown)
      }
    }) as unknown as DaemonCaller) as RunDeps['call']
  const deps: RunDeps = {
    call,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    env,
    home: '/home/tester',
    profileFileExists: () => true,
    ...(takeover === undefined ? {} : { takeover }),
  }
  return { deps, calls, out, err }
}

const argv = (...words: string[]) => ['node', 'fleet', ...words]
const ls = (state: string) => () => ({ peers: [{ peerId: 'engineer-1', state }] })

describe('fleet attach', () => {
  it('holds, runs the provider\'s command in the peer\'s cwd on the peer\'s env, then releases', async () => {
    const ran: { command: unknown; cwd: string; env: Readonly<Record<string, string>> }[] = []
    const takeover: Takeover = async (command, options) => {
      ran.push({ command, ...options })
      return { code: 0, signal: null }
    }
    const { deps, calls, out, err } = harness(
      { ls: ls('idle'), 'peer.hold': () => held, 'peer.release': () => ({ peerId: 'engineer-1', resumed: true }) },
      takeover,
    )
    assert.equal(await run(argv('attach', 'engineer-1'), deps), 0)
    assert.deepEqual(calls.map((c) => c.method), ['ls', 'peer.hold', 'peer.release'])
    assert.deepEqual(calls[1]?.params, { peerId: 'engineer-1' })
    assert.deepEqual(ran[0]?.command, held.command)
    assert.equal(ran[0]?.cwd, '/work/engineer-1')
    assert.equal(ran[0]?.env['ANTHROPIC_BASE_URL'], 'https://endpoint.example', 'the peer\'s endpoint, never this shell\'s stale one')
    assert.equal(ran[0]?.env['TERM'], 'xterm-256color', 'the terminal brings its own TERM')
    assert.equal(ran[0]?.env['PATH'], '/usr/bin', 'and its own PATH')
    assert.equal(ran[0]?.env['FLEET_PROFILE'], undefined, 'nothing else of this shell is inherited')
    assert.match(err.join('\n'), /2 messages are waiting for it/)
    assert.match(out[0] ?? '', /handed back engineer-1: the fleet resumed its session/)
  })

  it('says it is waiting when the peer is mid-turn, and passes --now through', async () => {
    const { deps, calls, err } = harness(
      { ls: ls('working'), 'peer.hold': () => held, 'peer.release': () => ({ peerId: 'engineer-1', resumed: true }) },
      async () => ({ code: 0, signal: null }),
    )
    assert.equal(await run(argv('attach', 'engineer-1'), deps), 0)
    assert.match(err[0] ?? '', /mid-turn; waiting for the turn to end/)
    const now = harness(
      { ls: ls('working'), 'peer.hold': () => held, 'peer.release': () => ({ peerId: 'engineer-1', resumed: true }) },
      async () => ({ code: 0, signal: null }),
    )
    assert.equal(await run(argv('attach', 'engineer-1', '--now'), now.deps), 0)
    assert.deepEqual(now.calls[1]?.params, { peerId: 'engineer-1', now: true })
    assert.match(now.err[0] ?? '', /interrupting it/)
    assert.equal(calls.length, 3)
  })

  it('releases even when the CLI crashed or could not be run at all', async () => {
    const crashed = harness(
      { ls: ls('idle'), 'peer.hold': () => held, 'peer.release': () => ({ peerId: 'engineer-1', resumed: true }) },
      async () => ({ code: null, signal: 'SIGKILL' }),
    )
    assert.equal(await run(argv('attach', 'engineer-1'), crashed.deps), 0)
    assert.equal(crashed.calls.at(-1)?.method, 'peer.release')

    const missing = harness(
      { ls: ls('idle'), 'peer.hold': () => held, 'peer.release': () => ({ peerId: 'engineer-1', resumed: true }) },
      async () => {
        throw new Error('spawn claude ENOENT')
      },
    )
    assert.equal(await run(argv('attach', 'engineer-1'), missing.deps), 1)
    assert.equal(missing.calls.at(-1)?.method, 'peer.release', 'handed back before the failure is reported')
    assert.match(missing.err.join('\n'), /could not run claude: spawn claude ENOENT; engineer-1 was handed back/)
  })

  it('tells the person how to hand back a peer whose release failed', async () => {
    const { deps, err } = harness(
      {
        ls: ls('idle'),
        'peer.hold': () => held,
        'peer.release': () => {
          throw new Error('fleetd went away')
        },
      },
      async () => ({ code: 0, signal: null }),
    )
    assert.equal(await run(argv('attach', 'engineer-1'), deps), 1)
    assert.match(err.join('\n'), /engineer-1 is still held: .* fleet release engineer-1 hands it back/)
  })

  it('refuses before holding anything when this build cannot hand the terminal over', async () => {
    const { deps, calls } = harness({ ls: ls('idle'), 'peer.hold': () => held })
    assert.equal(await run(argv('attach', 'engineer-1'), deps), 1)
    assert.deepEqual(calls, [])
  })
})

describe('fleet release, stop, start', () => {
  it('each calls its one method on the named peer', async () => {
    const { deps, calls, out } = harness({
      'peer.release': () => ({ peerId: 'engineer-1', resumed: false, reason: 'resume failed: gone' }),
      'peer.stop': () => ({ peerId: 'engineer-1', sessionRef: ref }),
      'peer.start': () => ({ peerId: 'engineer-1', resumed: true }),
    })
    assert.equal(await run(argv('release', 'engineer-1'), deps), 0)
    assert.equal(await run(argv('stop', 'engineer-1', '--now'), deps), 0)
    assert.equal(await run(argv('start', 'engineer-1'), deps), 0)
    assert.deepEqual(calls, [
      { method: 'peer.release', params: { peerId: 'engineer-1' } },
      { method: 'peer.stop', params: { peerId: 'engineer-1', now: true } },
      { method: 'peer.start', params: { peerId: 'engineer-1' } },
    ])
    assert.match(out[0] ?? '', /started a fresh session \(resume failed: gone\)/)
    assert.match(out[1] ?? '', /stopped engineer-1; fleet start engineer-1 brings it back/)
    assert.match(out[2] ?? '', /started engineer-1: the fleet resumed its session/)
  })

  it('refuses a peer name that is not a peer id, and a missing one', async () => {
    const { deps, calls } = harness({})
    assert.equal(await run(argv('stop', '../etc'), deps), 2)
    assert.equal(await run(argv('start'), deps), 2)
    assert.deepEqual(calls, [])
  })
})

describe('takeover env and banner', () => {
  it('the env is the peer\'s plus this terminal\'s own keys, and nothing else', () => {
    assert.deepEqual(takeoverEnv({ FLEET_PEER: 'a', PATH: '/daemon' }, { PATH: '/me', TERM: 'xterm', SECRET: 'no', LANG: '' }), {
      FLEET_PEER: 'a',
      PATH: '/me',
      TERM: 'xterm',
    })
  })

  it('warns that switching cursor out of plan mode writes into the shared checkout', () => {
    const lines = attachBanner({ ...held, providerId: 'cursor', pendingMessages: 0 } as never)
    assert.match(lines.join('\n'), /cursor opens in plan mode; switching mode lets you write into the shared checkout \/work\/engineer-1/)
    assert.match(lines.join('\n'), /no messages are waiting/)
  })
})
