/**
 * The stream-json parser, against lines the CLI is known to write (§4).
 *
 * A parser test is where a vendor's shape is pinned down: the adapter itself is
 * only as honest as this mapping, and a wrong key here shows up as a turn that
 * never ends rather than as an error.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseLine, parseLines, promptTokens, usageFrom } from '../src/stream.ts'

test('an init line yields the session and how the process came up', () => {
  const line = parseLine(
    '{"type":"system","subtype":"init","session_id":"abc","model":"Composer 2.5","permissionMode":"default"}',
  )
  assert.deepEqual(line, { kind: 'init', sessionId: 'abc', model: 'Composer 2.5', permissionMode: 'default' })
})

test('a system line that is not init says so rather than posing as one', () => {
  assert.deepEqual(parseLine('{"type":"system","subtype":"heartbeat"}'), { kind: 'other', type: 'system' })
})

test('an assistant line joins its text parts and drops the rest', () => {
  const line = parseLine(
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first ' },
          { type: 'thinking', thinking: 'not prose' },
          { type: 'text', text: 'second' },
        ],
      },
    }),
  )
  assert.deepEqual(line, { kind: 'assistant', text: 'first second', delta: false })
})

test('with --stream-partial-output a delta carries timestamp_ms and the closing line, which repeats the text, does not', () => {
  const delta = parseLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] }, timestamp_ms: 1794387735800 }))
  const closing = parseLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } }))
  assert.deepEqual(delta, { kind: 'assistant', text: 'one', delta: true })
  assert.deepEqual(closing, { kind: 'assistant', text: 'one', delta: false })
})

test('a tool call names the tool from the key the CLI keys it by', () => {
  const started = parseLine(
    '{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"shellToolCall":{"command":"ls"}}}',
  )
  assert.deepEqual(started, { kind: 'tool', phase: 'started', callId: 'c1', tool: 'shellToolCall' })
  const completed = parseLine('{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"readToolCall":{}}}')
  assert.deepEqual(completed, { kind: 'tool', phase: 'completed', callId: 'c1', tool: 'readToolCall' })
})

test('a tool call that names itself beats the key it is keyed by', () => {
  assert.deepEqual(parseLine('{"type":"tool_call","subtype":"started","tool_call":{"name":"grep","args":{}}}'), {
    kind: 'tool',
    phase: 'started',
    tool: 'grep',
  })
})

test('a tool call with nothing to name it is still a tool call', () => {
  const line = parseLine('{"type":"tool_call","subtype":"started"}')
  assert.deepEqual(line, { kind: 'tool', phase: 'started', tool: 'tool' })
})

test('a successful result carries its usage and no error', () => {
  const line = parseLine(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 34,
      result: 'done',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 1 },
    }),
  )
  assert.deepEqual(line, {
    kind: 'result',
    failed: false,
    durationMs: 34,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1 },
  })
})

test('a failed result keeps the CLI’s own explanation', () => {
  const line = parseLine('{"type":"result","subtype":"error","is_error":true,"result":"  the model refused "}')
  assert.deepEqual(line, { kind: 'result', failed: true, error: 'the model refused', usage: usageFrom(undefined) })
})

test('a result without a subtype is a failure, not a silent success', () => {
  const line = parseLine('{"type":"result"}')
  assert.equal(line?.kind, 'result')
  assert.equal(line.kind === 'result' && line.failed, true)
})

test('the cache keys are read under either spelling the CLI has used', () => {
  assert.deepEqual(usageFrom({ input_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 }), {
    inputTokens: 3,
    outputTokens: 0,
    cacheReadTokens: 7,
    cacheWriteTokens: 2,
  })
})

test('a missing or nonsense usage is zeros, never a guess', () => {
  assert.deepEqual(usageFrom(undefined), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.deepEqual(usageFrom({ input_tokens: -1, output_tokens: 'lots' }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
})

test('a blank line, a non-JSON warning and an array all parse to nothing', () => {
  assert.equal(parseLine('   '), undefined)
  assert.equal(parseLine('warning: config is odd'), undefined)
  assert.equal(parseLine('[{"type":"result"}]'), undefined)
})

test('a chunk is every line it holds, in order, with the noise dropped', () => {
  const chunk = [
    '{"type":"system","subtype":"init","session_id":"s"}',
    '',
    'not json',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
  ].join('\n')
  assert.deepEqual(
    parseLines(chunk).map((line) => line.kind),
    ['init', 'assistant'],
  )
})

test('the prompt side of a turn is input plus both cache counts', () => {
  assert.equal(
    promptTokens({ inputTokens: 10, outputTokens: 999, cacheReadTokens: 100, cacheWriteTokens: 1 }),
    111,
    'output is left out: it is what the next turn will carry, not what this one was given',
  )
})
