/**
 * One purge, end to end, without a provider, a process or a model: the peer is
 * a function that writes a file, and the restart is a function that hands back
 * a new handle.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fixedClock, type PeerId } from '@fleet/foundation-core'
import type { Provider, SessionHandle } from '@fleet/runtime-provider-sdk'

import { selfPurge, type PurgeEvent, type PurgePorts } from '../src/index.ts'

const peerId = 'engineer-1' as PeerId
const handle: SessionHandle = {
  sessionId: 'ses_aaaaaaaaaaaaaaaa',
  sessionRef: 'sess_old' as SessionHandle['sessionRef'],
  peerId,
  providerId: 'claude',
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
}
const fresh: SessionHandle = { ...handle, sessionId: 'ses_bbbbbbbbbbbbbbbb', sessionRef: 'sess_new' as SessionHandle['sessionRef'] }

const stateFile = (overrides: Record<string, unknown> = {}) => ({
  peerId,
  goal: 'ship the supervisor',
  done: ['peer-state mapping'],
  inFlight: ['purge protocol'],
  next: ['tests'],
  decisions: [],
  openQuestions: [],
  briefVersion: 4,
  ...overrides,
})

interface Harness {
  readonly ports: PurgePorts
  readonly events: readonly PurgeEvent[]
  readonly asks: readonly string[]
  readonly files: readonly { path: string; text: string }[]
  readonly stopped: readonly string[]
}

const harness = (
  replies: readonly (string | undefined)[],
  options: { readonly restartFails?: Error } = {},
): Harness => {
  const events: PurgeEvent[] = []
  const asks: string[] = []
  const files: { path: string; text: string }[] = []
  const stopped: string[] = []
  let attempt = 0

  const provider = {
    usage: async () => ({ contextTokens: 900, contextLimit: 1_000 }),
    stop: async (h: SessionHandle) => {
      stopped.push(h.sessionId)
    },
  } as unknown as Pick<Provider, 'usage' | 'stop'>

  return {
    events,
    asks,
    files,
    stopped,
    ports: {
      provider,
      handle,
      peerId,
      briefVersion: 4,
      ask: async (text: string) => {
        asks.push(text)
      },
      stateFileText: async () => replies[attempt++],
      restart: async () => {
        if (options.restartFails !== undefined) throw options.restartFails
        return { handle: fresh, replayedMessages: 2 }
      },
      facts: () => ({
        peerId,
        briefVersion: 4,
        goal: 'ship the supervisor',
        assignedWork: ['supervisor: purge'],
        prs: ['#26'],
        branch: 'fleet-purge',
      }),
      record: (event: PurgeEvent) => {
        events.push(event)
      },
      writeFile: async (path: string, text: string) => {
        files.push({ path, text })
      },
      stateFilePath: (id: PeerId) => `/state/peers/${id}/state.md`,
      clock: fixedClock('2026-11-10T09:00:00.000Z'),
    },
  }
}

test('a valid state file is saved, written for humans, and the session restarts', async () => {
  const h = harness([JSON.stringify(stateFile())])
  const outcome = await selfPurge(h.ports)

  assert.equal(outcome.degraded, false)
  assert.equal(outcome.handle.sessionId, fresh.sessionId)
  assert.equal(outcome.stateFile.briefVersion, 4)

  assert.deepEqual(
    h.events.map((event) => event.type),
    ['purge.started', 'purge.saved', 'purge.completed'],
  )
  assert.deepEqual(h.stopped, [handle.sessionId])
  assert.equal(h.asks.length, 1)
  assert.equal(h.files.length, 1)
  assert.equal(h.files[0]?.path, `/state/peers/${peerId}/state.md`)
  assert.match(h.files[0]?.text ?? '', /## Next\n\n- tests/)

  const completed = h.events[2]
  assert.ok(completed?.type === 'purge.completed')
  assert.equal(completed.fromSessionId, handle.sessionId)
  assert.equal(completed.toSessionId, fresh.sessionId)
  assert.equal(completed.replayedMessages, 2)

  // The trigger numbers are the provider's, recorded as they were (§8).
  const started = h.events[0]
  assert.ok(started?.type === 'purge.started')
  assert.equal(started.contextTokens, 900)
  assert.equal(started.contextLimit, 1_000)
})

test('the second ask carries why the first reply was refused', async () => {
  const h = harness([JSON.stringify(stateFile({ next: undefined })), JSON.stringify(stateFile())])
  const outcome = await selfPurge(h.ports)

  assert.equal(outcome.degraded, false)
  assert.equal(h.asks.length, 2)
  assert.doesNotMatch(h.asks[0] ?? '', /not accepted/)
  assert.match(h.asks[1] ?? '', /previous attempt was not accepted: .*next/)
})

test('after two refusals the handoff degrades to facts, and still restarts', async () => {
  const h = harness(['I could not write it', 'still no'])
  const outcome = await selfPurge(h.ports)

  assert.equal(outcome.degraded, true)
  assert.match(outcome.reason ?? '', /not valid JSON/)
  assert.deepEqual(outcome.stateFile.inFlight, ['supervisor: purge', '#26'])
  assert.deepEqual(outcome.stateFile.next, [])

  assert.deepEqual(
    h.events.map((event) => event.type),
    ['purge.started', 'purge.degraded', 'purge.completed'],
  )
  const degraded = h.events[1]
  assert.ok(degraded?.type === 'purge.degraded')
  assert.match(degraded.reason, /not valid JSON/)
  // The human copy exists even when the peer wrote nothing usable.
  assert.equal(h.files.length, 1)
})

test('a peer that writes nothing at all is degraded, not stuck', async () => {
  const h = harness([undefined, undefined])
  const outcome = await selfPurge(h.ports)
  assert.equal(outcome.degraded, true)
  assert.equal(h.asks.length, 2)
  assert.deepEqual(h.stopped, [handle.sessionId])
})

test('a state file naming another peer is refused and asked again', async () => {
  const h = harness([JSON.stringify(stateFile({ peerId: 'engineer-2' })), JSON.stringify(stateFile())])
  const outcome = await selfPurge(h.ports)
  assert.equal(outcome.degraded, false)
  assert.equal(h.asks.length, 2)
  assert.match(h.asks[1] ?? '', /engineer-2, not engineer-1/)
})

test('a failed restart is not swallowed: a peer with no session must be visible', async () => {
  const h = harness([JSON.stringify(stateFile())], { restartFails: Object.assign(new Error('no cwd'), { code: 'invalid_input' }) })
  await assert.rejects(selfPurge(h.ports), /no cwd/)
  // It stopped the old session, so a silent failure would leave the peer dead.
  assert.deepEqual(h.stopped, [handle.sessionId])
  assert.equal(h.events.at(-1)?.type, 'purge.saved')
})
