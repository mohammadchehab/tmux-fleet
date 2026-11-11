/**
 * A session that never reaches `init` (§4, TASK-17).
 *
 * The case this exists for: the provider's OAuth token expired, the CLI ended
 * the query with `is_error`, and `peer.failed` read "session did not initialise
 * in 60000ms" — the timeout we waited, not the sentence the provider had
 * already sent. A stand-in `query` is the only way to drive that without a CLI,
 * which is what `ClaudeSessionConfig.query` is for.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PeerId } from '@fleet/foundation-core'
import type { SessionSpec } from '@fleet/runtime-provider-sdk'

import { ClaudeProvider } from '../src/provider.ts'
import type { QueryFactory } from '../src/session.ts'

/** A `query` stand-in: the script is the SDK's message stream, and nothing else is called. */
const queryThat = (script: () => AsyncGenerator<unknown>): QueryFactory =>
  (() => ({
    [Symbol.asyncIterator]: script,
    close: () => undefined,
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setPermissionMode: async () => undefined,
    getContextUsage: async () => ({}),
  })) as unknown as QueryFactory

const spec = (): SessionSpec => ({
  peerId: 'peer-1' as PeerId,
  role: 'engineer',
  cwd: process.cwd(),
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
  env: {},
  brief: {
    briefId: 'brf_00000000000000b7' as SessionSpec['brief']['briefId'],
    version: 1,
    contractVersions: [],
    text: 'Build the thing.',
  },
})

test('a session that ends before init fails with the provider’s own error, not the timeout (§4)', async () => {
  const started = Date.now()
  const provider = new ClaudeProvider({
    // Long on purpose: the assertion below is that this is never waited out.
    initTimeoutMs: 60_000,
    query: queryThat(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'OAuth token has expired · run /login to renew it',
      }
    }),
  })

  await assert.rejects(provider.start(spec()), (thrown: unknown) => {
    assert.ok(thrown instanceof Error)
    assert.match(thrown.message, /ended before it initialised/)
    assert.match(thrown.message, /OAuth token has expired/)
    assert.doesNotMatch(thrown.message, /did not initialise in/)
    return true
  })
  assert.ok(Date.now() - started < 10_000, 'the cause was known as soon as the stream ended')
})

test('a session whose stream throws before init carries the thrown sentence (§4)', async () => {
  const provider = new ClaudeProvider({
    initTimeoutMs: 60_000,
    query: queryThat(async function* () {
      throw new Error('Invalid API key · please run /login')
    }),
  })

  await assert.rejects(provider.start(spec()), /Invalid API key/)
})

test('a session that simply never answers is still the timeout (§4)', async () => {
  const provider = new ClaudeProvider({
    initTimeoutMs: 50,
    query: queryThat(async function* () {
      await new Promise(() => undefined)
    }),
  })

  // The session's own timeout timer is unref'd on purpose — a provider that never
  // answers must not keep the process alive — so this test has to hold the loop
  // itself. Without it the runner finds nothing pending, cancels the test with
  // "Promise resolution is still pending but the event loop has already resolved"
  // and the timeout never gets to fire.
  const holding = setInterval(() => undefined, 1_000)
  try {
    await assert.rejects(provider.start(spec()), /did not initialise in 50ms/)
  } finally {
    clearInterval(holding)
  }
})

test('a peer cannot reach another Claude Code session: SendMessage and ListAgents are denied in every permission mode', async () => {
  const seen: { disallowedTools?: unknown; permissionMode?: unknown }[] = []
  const capture = ((args: { options: { disallowedTools?: unknown; permissionMode?: unknown } }) => {
    seen.push(args.options)
    return {
      // Ends before init: `start` rejects, and the options it was started with are what is under test.
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'stop here' }
      },
      close: () => undefined,
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      getContextUsage: async () => ({}),
    }
  }) as unknown as QueryFactory
  const provider = new ClaudeProvider({ initTimeoutMs: 5_000, query: capture })
  for (const permissionMode of ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const) {
    await provider.start({ ...spec(), permissionMode }).catch(() => undefined)
  }
  assert.equal(seen.length, 4)
  for (const options of seen) {
    assert.deepEqual(options.disallowedTools, ['SendMessage', 'ListAgents'], `${String(options.permissionMode)}: the cross-session tools are removed`)
  }
  await provider.resume('11111111-1111-1111-1111-111111111111' as never, spec()).catch(() => undefined)
  assert.deepEqual(seen.at(-1)?.disallowedTools, ['SendMessage', 'ListAgents'], 'a resumed session too')
})

const delta = (text: string, kind: 'text_delta' | 'thinking_delta' = 'text_delta', parent: string | null = null) => ({
  type: 'stream_event',
  parent_tool_use_id: parent,
  event: { type: 'content_block_delta', index: 0, delta: kind === 'text_delta' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } },
})

/** One brief turn as the SDK streams it with `includePartialMessages`: deltas, then the whole assistant message, then the result. */
async function* briefTurn(): AsyncGenerator<unknown> {
  yield { type: 'system', subtype: 'init', session_id: 'sess_display', model: 'claude-sonnet-5-5', permissionMode: 'default' }
  yield delta('Hel')
  yield delta('SECRET reasoning that must not reach the view', 'thinking_delta')
  yield delta('lo')
  yield delta('a subagent talking', 'text_delta', 'toolu_subagent')
  yield {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'list the files' } },
      ],
    },
  }
  yield { type: 'result', subtype: 'success', is_error: false, result: 'Hello', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }
}

test('the display carries the peer’s words, its tools and its turn boundaries — not its thinking, not a subagent — and the contract events do not move', async () => {
  const seen: { includePartialMessages?: unknown }[] = []
  const factory = ((args: { options: { includePartialMessages?: unknown } }) => {
    seen.push(args.options)
    return {
      [Symbol.asyncIterator]: briefTurn,
      close: () => undefined,
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      getContextUsage: async () => ({}),
    }
  }) as unknown as QueryFactory
  const provider = new ClaudeProvider({ initTimeoutMs: 5_000, query: factory })
  const handle = await provider.start(spec())
  assert.equal(seen[0]?.includePartialMessages, true, 'the SDK is asked for deltas')

  const lines: string[] = []
  for await (const line of provider.display(handle)) {
    lines.push(line.kind === 'text' ? `text:${line.text}` : line.kind === 'tool' ? `tool:${line.tool}:${line.summary ?? ''}` : `turn:${line.phase}${line.reason === undefined ? '' : `:${line.reason}`}`)
  }
  assert.deepEqual(lines, ['turn:started', 'text:Hel', 'text:lo', 'tool:Bash:', 'turn:ended:completed'])
  // A Bash command is never summarised (the redaction `tool.use` already applies): the display adds no second path to it.
  assert.ok(!lines.some((line) => /SECRET|subagent/.test(line)))

  // Conformance (§12): the display says a turn started and ended exactly when the contract events do.
  const contract: string[] = []
  for await (const event of provider.events(handle)) {
    if (event.type === 'turn.started' || event.type === 'turn.ended') contract.push(event.type)
  }
  assert.deepEqual(contract, ['turn.started', 'turn.ended'], 'the deltas added no contract events')
})

test('a message queued behind a running turn is folded into its result: both turns end, so a hold can reach the boundary (TASK-103)', async () => {
  // The CLI answers the brief and the queued message with ONE result, then says nothing.
  const factory = (() => ({
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess_fold', model: 'claude-sonnet-5-5', permissionMode: 'default' }
      await new Promise((resolve) => setTimeout(resolve, 30))
      yield { type: 'result', subtype: 'success', is_error: false, result: 'both' }
      await new Promise(() => undefined)
    },
    close: () => undefined,
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setPermissionMode: async () => undefined,
    getContextUsage: async () => ({}),
  })) as unknown as QueryFactory
  const provider = new ClaudeProvider({ initTimeoutMs: 5_000, foldQuietMs: 50, query: factory })
  const holding = setInterval(() => undefined, 1_000)
  let handle: Awaited<ReturnType<typeof provider.start>> | undefined
  try {
    handle = await provider.start(spec())
    await provider.send(handle, { text: 'one more thing', kind: 'nudge', briefVersion: 1 } as never)

    const started: string[] = []
    const ended: string[] = []
    for await (const event of provider.events(handle)) {
      if (event.type === 'turn.started') started.push(event.turnId)
      if (event.type === 'turn.ended') {
        ended.push(event.turnId)
        if (ended.length === started.length) break
      }
    }
    assert.equal(started.length, 2)
    assert.deepEqual([...ended].sort(), [...started].sort(), 'every turn that started also ended')
  } finally {
    clearInterval(holding)
    if (handle !== undefined) await provider.stop(handle).catch(() => undefined)
  }
})
