/**
 * A cursor session, driven end to end against a stand-in `cursor-agent`
 * (`test/fixtures/fake-cursor-agent.mjs`), so the arguments the adapter builds
 * and the events it reports are both observable without spending a turn (§4).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { PeerId } from '@fleet/foundation-core'
import type { ProviderEvent, ProviderSessionRef, SessionHandle, SessionSpec, Turn } from '@fleet/runtime-provider-sdk'

import { CursorProvider } from '../src/provider.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-cursor-agent.mjs', import.meta.url))
const MODEL = 'composer-2.5'
const LIMIT = 200_000

/** A provider driving the stand-in, plus the log it writes its arguments to. */
const harness = (): {
  provider: CursorProvider
  spec: (over?: Partial<SessionSpec>) => SessionSpec
  calls: () => readonly (readonly string[])[]
} => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cursor-'))
  const log = join(dir, 'calls.jsonl')
  const provider = new CursorProvider({
    executable: process.execPath,
    executableArgs: [FAKE],
    contextLimits: { [MODEL]: LIMIT },
  })
  const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
    peerId: 'peer-1' as PeerId,
    role: 'engineer',
    cwd: dir,
    model: MODEL,
    permissionMode: 'plan',
    env: { FAKE_CURSOR_LOG: log },
    brief: { briefId: 'brf_00000000000000aa' as SessionSpec['brief']['briefId'], version: 1, contractVersions: [], text: 'Build the thing.' },
    ...over,
  })
  const calls = (): readonly (readonly string[])[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as string[])
      : []
  return { provider, spec, calls }
}

/** Read the session's events in the background, and resolve when one matches. */
const watch = (
  provider: CursorProvider,
  handle: SessionHandle,
): { events: ProviderEvent[]; until: (match: (event: ProviderEvent) => boolean) => Promise<ProviderEvent> } => {
  const events: ProviderEvent[] = []
  let waiter: { match: (event: ProviderEvent) => boolean; resolve: (event: ProviderEvent) => void } | undefined
  void (async () => {
    for await (const event of provider.events(handle)) {
      events.push(event)
      const pending = waiter
      if (pending !== undefined && pending.match(event)) {
        waiter = undefined
        pending.resolve(event)
      }
    }
  })()
  return {
    events,
    until: (match) =>
      new Promise((resolve) => {
        const seen = events.find(match)
        if (seen !== undefined) {
          resolve(seen)
          return
        }
        waiter = { match, resolve }
      }),
  }
}

const ended = (turnId?: string) => (event: ProviderEvent): boolean =>
  event.type === 'turn.ended' && (turnId === undefined || event.turnId === turnId)

const turn = (text: string): Turn => ({ text, kind: 'info', briefVersion: 1 })

test('start() creates a chat and delivers the brief as its opening turn', async () => {
  const { provider, spec, calls } = harness()
  const handle = await provider.start(spec())
  const seen = watch(provider, handle)

  assert.match(handle.sessionRef, /^[0-9a-f-]{36}$/, 'the handle carries the chat id create-chat printed')
  assert.equal(handle.permissionMode, 'plan', 'a cursor session is only ever plan-mode')
  assert.equal(handle.model, MODEL)

  const first = await seen.until((event) => event.type === 'turn.started')
  assert.equal(first.type === 'turn.started' && first.turnId, handle.briefTurnId, 'the brief is a real turn, and the handle names it')

  const done = await seen.until(ended(handle.briefTurnId))
  assert.equal(done.type === 'turn.ended' && done.reason, 'completed')

  const [createChat, opening] = calls()
  assert.deepEqual(createChat, ['create-chat'], 'the chat is created before anything is spent')
  assert.deepEqual(opening?.slice(0, 8), [
    '-p',
    '--output-format',
    'stream-json',
    '--mode',
    'plan',
    '--model',
    MODEL,
    '--resume',
  ])
  assert.equal(opening?.[8], handle.sessionRef, 'the turn continues the chat the handle names')
  assert.match(String(opening?.[9]), /You are the engineer peer on the peer-1 account\./)
  assert.match(String(opening?.[9]), /You are running read-only, in plan mode/, 'the peer is told what it can do')
  await provider.stop(handle)
})

test('a turn reports one tool.use per call and measures its own context', async () => {
  const { provider, spec } = harness()
  const handle = await provider.start(spec())
  const seen = watch(provider, handle)
  await seen.until(ended(handle.briefTurnId))

  const turnId = await provider.send(handle, turn('what is left to do'))
  await seen.until(ended(turnId))

  const tools = seen.events.filter((event) => event.type === 'tool.use' && event.turnId === turnId)
  assert.equal(tools.length, 1, 'one call, reported once: the completed line is not a second use')
  assert.deepEqual(
    tools.map((event) => event.type === 'tool.use' && event.tool),
    ['shellToolCall'],
  )
  assert.deepEqual(await provider.usage(handle), {
    contextTokens: 111,
    contextLimit: LIMIT,
  })
  assert.equal(await provider.status(handle), 'idle')
  await provider.stop(handle)
})

test('a send while a turn is live is a conflict, not a queue', async () => {
  const { provider, spec } = harness()
  const handle = await provider.start(spec())
  const seen = watch(provider, handle)
  await seen.until(ended(handle.briefTurnId))

  await provider.send(handle, turn('INTERRUPT me later'))
  await seen.until((event) => event.type === 'turn.started')
  await assert.rejects(
    () => provider.send(handle, turn('a second message')),
    (thrown: unknown) => (thrown as { code?: string }).code === 'conflict',
    'one chat takes one turn at a time; queueing here would hide a caller that overlaps them',
  )
  await provider.stop(handle)
})

test('interrupt() ends the live turn and leaves the session usable', async () => {
  const { provider, spec } = harness()
  const handle = await provider.start(spec())
  const seen = watch(provider, handle)
  await seen.until(ended(handle.briefTurnId))

  const interrupted = await provider.send(handle, turn('INTERRUPT now'))
  await seen.until((event) => event.type === 'turn.started' && event.turnId === interrupted)
  await provider.interrupt(handle)

  const done = await seen.until(ended(interrupted))
  assert.equal(done.type === 'turn.ended' && done.reason, 'interrupted')

  const next = await provider.send(handle, turn('carry on'))
  const after = await seen.until(ended(next))
  assert.equal(after.type === 'turn.ended' && after.reason, 'completed', 'the chat outlives the process that was killed')
  await provider.stop(handle)
})

test('a failed turn says why, and is retryable', async () => {
  const { provider, spec } = harness()
  const handle = await provider.start(spec())
  const seen = watch(provider, handle)
  await seen.until(ended(handle.briefTurnId))

  const turnId = await provider.send(handle, turn('FAIL please'))
  const done = await seen.until(ended(turnId))
  assert.equal(done.type === 'turn.ended' && done.reason, 'failed')
  assert.equal(done.type === 'turn.ended' && done.error, 'the model refused')

  const error = await seen.until((event) => event.type === 'error')
  assert.deepEqual(error, { type: 'error', message: 'the model refused', retryable: true })
  await provider.stop(handle)
})

test('a process that exits without a result fails its turn and names the exit', async () => {
  const { provider, spec } = harness()
  const handle = await provider.start(spec())
  const seen = watch(provider, handle)
  await seen.until(ended(handle.briefTurnId))

  const turnId = await provider.send(handle, turn('CRASH please'))
  const done = await seen.until(ended(turnId))
  assert.equal(done.type === 'turn.ended' && done.reason, 'failed')
  assert.match(done.type === 'turn.ended' ? String(done.error) : '', /exited with code 3 without reporting a result/)
  assert.equal(await provider.status(handle), 'idle', 'a crashed turn leaves the chat resumable, so the session is idle not ended')
  await provider.stop(handle)
})

test('model() reports the requested id, and a switch is the next turn’s --model', async () => {
  const { provider, spec, calls } = harness()
  const handle = await provider.start(spec({ model: MODEL }))
  const seen = watch(provider, handle)
  await seen.until(ended(handle.briefTurnId))

  assert.deepEqual(await provider.model(handle), { id: MODEL })
  await provider.setModel(handle, MODEL)
  assert.deepEqual(await provider.model(handle), { id: MODEL }, 'the switch is requested, not confirmed: the CLI reports a display name')

  const turnId = await provider.send(handle, turn('again'))
  await seen.until(ended(turnId))
  const last = calls().at(-1)
  assert.equal(last?.[last.indexOf('--model') + 1], MODEL)
  await provider.stop(handle)
})

test('stop() ends the session as stopped and closes the stream', async () => {
  const { provider, spec } = harness()
  const handle = await provider.start(spec())
  const seen = watch(provider, handle)
  await seen.until(ended(handle.briefTurnId))

  await provider.stop(handle)
  const endedEvent = await seen.until((event) => event.type === 'session.ended')
  assert.deepEqual(endedEvent, { type: 'session.ended', reason: 'stopped' })
  assert.equal(await provider.status(handle), 'ended')
  await assert.rejects(
    () => provider.send(handle, turn('anyone there')),
    (thrown: unknown) => (thrown as { code?: string }).code === 'conflict',
  )
})

test('resume() continues the chat it is handed rather than creating one', async () => {
  const { provider, spec, calls } = harness()
  const ref = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as ProviderSessionRef
  const resumed = await provider.resume(ref, spec())
  const seen = watch(provider, resumed)
  assert.equal(resumed.sessionRef, ref)
  await seen.until(ended(resumed.briefTurnId))

  assert.equal(
    calls().filter((args) => args[0] === 'create-chat').length,
    0,
    'resuming a chat must not create another one',
  )
  assert.equal(calls().at(-1)?.at(-3), '--resume')
  assert.equal(calls().at(-1)?.at(-2), ref)
  await provider.stop(resumed)
})

test('a ref that is not a chat id is refused before anything resumes', async () => {
  const { provider, spec } = harness()
  await assert.rejects(
    () => provider.resume('not-a-chat' as ProviderSessionRef, spec()),
    (thrown: unknown) => (thrown as { code?: string }).code === 'invalid_input',
  )
})

test('the spawned cursor-agent runs in spec.cwd, so it reads that checkout’s own instructions', async () => {
  const { provider, spec } = harness()
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-cursor-checkout-')))
  const cwdLog = join(checkout, '..', `${checkout.split('/').pop()}.cwd`)
  const handle = await provider.start(spec({ cwd: checkout, env: { FAKE_CURSOR_CWD_LOG: cwdLog } }))
  const seen = watch(provider, handle)
  await seen.until(ended(handle.briefTurnId))

  // create-chat and the opening turn are both spawned: neither may start anywhere else.
  const where = readFileSync(cwdLog, 'utf8').split('\n').filter((line) => line !== '')
  assert.deepEqual(where.map((dir) => realpathSync(dir)), [checkout, checkout])
})

test('fleetd’s own environment never reaches the cursor child: only the allowlist and the spec’s env do', async () => {
  const { provider, spec } = harness()
  const log = join(mkdtempSync(join(tmpdir(), 'fleet-cursor-env-')), 'env.jsonl')
  const leaked = {
    FLEET_TEST_AWS_SECRET_ACCESS_KEY: 'aws-secret',
    FLEET_TEST_GITHUB_TOKEN: 'ghp_secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    DEEPINFRA_API_KEY: 'di-secret',
    // cursor-agent's own key variable: ambient, it is just another secret fleetd holds.
    CURSOR_API_KEY: 'cur-ambient-secret',
  }
  const before = Object.fromEntries(Object.keys(leaked).map((key) => [key, process.env[key]]))
  Object.assign(process.env, leaked)
  try {
    const handle = await provider.start(spec({ env: { FAKE_CURSOR_ENV_LOG: log, FAKE_CURSOR_LOG: join(tmpdir(), 'fleet-cursor-unused.jsonl'), FLEET_PEER: 'peer-1' } }))
    await watch(provider, handle).until(ended(handle.briefTurnId))
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  // create-chat and the turn are two processes; neither may see a secret.
  const seen = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as string[])
  assert.equal(seen.length, 2)
  for (const keys of seen) {
    for (const key of Object.keys(leaked)) assert.ok(!keys.includes(key), `${key} reached the cursor child`)
    assert.ok(keys.includes('PATH'), 'the child is still a working process')
    assert.ok(keys.includes('FLEET_PEER'), 'what the spec asked for arrives')
  }
})

test('a cursor key arrives only when the spec carries it, never by inheritance', async () => {
  const { provider, spec } = harness()
  const log = join(mkdtempSync(join(tmpdir(), 'fleet-cursor-env-')), 'env.jsonl')
  const before = process.env.CURSOR_API_KEY
  process.env.CURSOR_API_KEY = 'cur-ambient-secret'
  try {
    // No spec key: the ambient one must not stand in for it.
    const bare = await provider.start(spec({ env: { FAKE_CURSOR_ENV_LOG: log } }))
    await watch(provider, bare).until(ended(bare.briefTurnId))
    // A spec key: deliberate, so it arrives.
    const keyed = await provider.start(spec({ env: { FAKE_CURSOR_ENV_LOG: log, CURSOR_API_KEY: 'cur-configured' } }))
    await watch(provider, keyed).until(ended(keyed.briefTurnId))
  } finally {
    if (before === undefined) delete process.env.CURSOR_API_KEY
    else process.env.CURSOR_API_KEY = before
  }

  const seen = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as string[])
  assert.equal(seen.length, 4, 'create-chat and a turn for each session')
  assert.ok(seen.slice(0, 2).every((keys) => !keys.includes('CURSOR_API_KEY')), 'ambient key withheld')
  assert.ok(seen.slice(2).every((keys) => keys.includes('CURSOR_API_KEY')), 'the spec’s key arrives')
})
