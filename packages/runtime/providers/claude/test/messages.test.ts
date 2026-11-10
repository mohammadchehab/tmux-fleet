/**
 * Stream messages → adapter events. The fixtures are the real message shapes the
 * spike recorded for both endpoints (`spikes/agent-sdk/results/*-evidence.jsonl`),
 * reduced to the fields the mapping reads.
 *
 * The turn boundary is the important one: `interrupt()` does not arrive as an
 * exception, it arrives as an ordinary `result` with `is_error: true`, so the
 * only difference between "the supervisor stopped this" and "the turn failed" is
 * what the adapter knew when it asked for the interrupt.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TurnId } from '@fleet/foundation-core'

import { mapMessage, questionAnswers, readQuestions, summariseToolUse } from '../src/index.ts'

const turn = 'trn_0123456789abcdef' as TurnId
const at = '2026-08-20T10:00:00.000Z'
const live = { interrupted: false }

test('init maps to session.started with the model and mode the process came up in', () => {
  const events = mapMessage(
    { type: 'system', subtype: 'init', session_id: 'sess_abc', model: 'claude-opus-5-5', permissionMode: 'default' },
    turn,
    live,
    at,
  )
  assert.deepEqual(events, [
    {
      type: 'session.started',
      at,
      sessionRef: 'sess_abc',
      model: 'claude-opus-5-5',
      permissionMode: 'default',
    },
  ])
})

test('an init with no session id is an error, not a session', () => {
  const events = mapMessage({ type: 'system', subtype: 'init', model: 'x', permissionMode: 'default' }, turn, live, at)
  assert.equal(events[0]?.type, 'error')
})

test('assistant tool calls become tool.use with a short summary and nothing else', () => {
  const events = mapMessage(
    {
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        content: [
          { type: 'text', text: 'working' },
          { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', description: 'run tests' } },
          { type: 'tool_use', name: 'mcp__codegraph__explore', input: { query: 'Provider' } },
        ],
      },
    },
    turn,
    live,
    at,
  )
  assert.deepEqual(events, [
    { type: 'tool.use', turnId: turn, tool: 'Bash', summary: 'pnpm test' },
    { type: 'tool.use', turnId: turn, tool: 'mcp__codegraph__explore' },
  ])
})

test('a successful result ends the turn as completed', () => {
  const events = mapMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' }, turn, live, at)
  assert.deepEqual(events, [{ type: 'turn.ended', turnId: turn, at, reason: 'completed' }])
})

test('a failed result ends the turn as failed and keeps the reason text', () => {
  const events = mapMessage(
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'rate limited' },
    turn,
    live,
    at,
  )
  assert.deepEqual(events, [{ type: 'turn.ended', turnId: turn, at, reason: 'failed', error: 'rate limited' }])
})

test('after interrupt() the same aborted result reads as interrupted, not failed', () => {
  const aborted = { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'aborted_tools' }
  assert.equal((mapMessage(aborted, turn, live, at)[0] as { reason?: string }).reason, 'failed')
  assert.equal(
    (mapMessage(aborted, turn, { interrupted: true }, at)[0] as { reason?: string }).reason,
    'interrupted',
  )
})

test('a compact boundary reports what it dropped', () => {
  const events = mapMessage(
    {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 15492, post_tokens: 4476 },
    },
    turn,
    live,
    at,
  )
  assert.deepEqual(events, [{ type: 'compaction', turnId: turn, contextTokensBefore: 15492, contextTokensAfter: 4476 }])
})

test('every other message kind is silent', () => {
  for (const message of [
    { type: 'system', subtype: 'status', status: 'compacting' },
    { type: 'rate_limit_event' },
    { type: 'stream_event' },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    null,
    'text',
  ]) {
    assert.deepEqual(mapMessage(message, turn, live, at), [])
  }
})

test('no turn open means no turn events', () => {
  assert.deepEqual(mapMessage({ type: 'result', subtype: 'success', is_error: false }, undefined, live, at), [])
})

test('tool summaries name one safe field per tool, truncated, and nothing for the rest', () => {
  assert.equal(summariseToolUse('Bash', { command: 'ls' }), 'ls')
  assert.equal(summariseToolUse('Read', { file_path: '/tmp/a.ts' }), '/tmp/a.ts')
  assert.equal(summariseToolUse('WebFetch', { url: 'https://example.com' }), 'https://example.com')
  assert.equal(summariseToolUse('Bash', { command: 'x'.repeat(500) })?.length, 200)
  assert.equal(summariseToolUse('mcp__x__y', { anything: 'here' }), undefined)
})

test('AskUserQuestion input is read into typed questions', () => {
  const questions = readQuestions({
    questions: [
      {
        question: 'Which channel?',
        header: 'Channel',
        multiSelect: false,
        options: [{ label: 'Blue', description: 'the calm one' }, { label: 'Green' }],
      },
    ],
  })
  assert.deepEqual(questions, [
    {
      question: 'Which channel?',
      header: 'Channel',
      multiSelect: false,
      options: [{ label: 'Blue', description: 'the calm one' }, { label: 'Green' }],
    },
  ])
  assert.equal(readQuestions({ not: 'a question' }), undefined)
})

test('an answer is keyed by the question text and keeps an option label intact', () => {
  assert.deepEqual(questionAnswers([{ question: 'Which channel?', options: [{ label: 'Blue' }] }], 'Blue'), {
    'Which channel?': 'Blue',
  })
  assert.deepEqual(questionAnswers([{ question: 'Why?' }], 'because'), { 'Why?': 'because' })
})
