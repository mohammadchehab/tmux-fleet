/**
 * Stream messages → adapter events. The fixtures are the real message shapes the
 * spike recorded for both endpoints (`docs/design/spikes/agent-sdk.md`), reduced to
 * the fields the mapping reads.
 *
 * The turn boundary is the important one: `interrupt()` does not arrive as an
 * exception, it arrives as an ordinary `result` with `is_error: true`, so the
 * only difference between "the supervisor stopped this" and "the turn failed" is
 * what the adapter knew when it asked for the interrupt.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TurnId } from '@fleet/foundation-core'

import { displaySummary, displayToolUses, mapMessage, questionAnswers, readQuestions, summariseToolUse } from '../src/index.ts'

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
          { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/a.ts' } },
          { type: 'tool_use', name: 'mcp__codegraph__explore', input: { query: 'Provider' } },
        ],
      },
    },
    turn,
    live,
    at,
  )
  assert.deepEqual(events, [
    // A command is not a target this adapter will put in the stream; a path is.
    { type: 'tool.use', turnId: turn, tool: 'Bash' },
    { type: 'tool.use', turnId: turn, tool: 'Edit', summary: '/tmp/a.ts' },
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
  assert.deepEqual(events, [
    { type: 'compaction', turnId: turn, trigger: 'manual', contextTokensBefore: 15492, contextTokensAfter: 4476 },
  ])
})

test('a compaction between turns is reported too, since that is the one nobody sees', () => {
  const events = mapMessage(
    {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 198400, post_tokens: 21400 },
    },
    undefined,
    live,
    at,
  )
  assert.deepEqual(events, [
    { type: 'compaction', trigger: 'auto', contextTokensBefore: 198400, contextTokensAfter: 21400 },
  ])
})

test('a compact boundary with an unrecognised trigger is reported as unknown, not dropped', () => {
  const events = mapMessage(
    {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'something-new', pre_tokens: 900, post_tokens: 100 },
    },
    turn,
    live,
    at,
  )
  assert.deepEqual(events, [
    { type: 'compaction', turnId: turn, trigger: 'unknown', contextTokensBefore: 900, contextTokensAfter: 100 },
  ])
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

test('a target is the path an edit-family call names, and nothing else', () => {
  for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(summariseToolUse(tool, { file_path: '/tmp/a.ts' }), '/tmp/a.ts', tool)
  }
  // Bounded so one log row stays small — a cut, not a redaction.
  assert.equal(summariseToolUse('Read', { file_path: `/${'x'.repeat(500)}` })?.length, 200)
  // The allowlist is default-deny: a call whose summary would be a command, a
  // URL, a search, a brief or an MCP payload has no target at all, and neither
  // does a tool this adapter has never seen.
  for (const [tool, input] of [
    ['Bash', { command: 'curl https://x/?token=abc' }],
    ['Bash', { command: 'ls' }],
    ['WebFetch', { url: 'https://example.com/?token=abc' }],
    ['WebFetch', { url: 'https://user:pw@example.com' }],
    ['WebSearch', { query: 'api_key=sk_live_abc' }],
    ['Task', { description: 'deploy with token abc' }],
    ['Agent', { description: 'deploy with token abc' }],
    ['mcp__x__y', { anything: 'here', file_path: '/tmp/a.ts' }],
    ['SomeToolAddedTomorrow', { file_path: '/tmp/a.ts' }],
  ] as const) {
    assert.equal(summariseToolUse(tool, input), undefined, tool)
  }
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

test('an answer is keyed by the question text, one label per question, in the order asked', () => {
  assert.deepEqual(questionAnswers([{ question: 'Which channel?', options: [{ label: 'Blue' }] }], ['Blue']), {
    'Which channel?': 'Blue',
  })
  assert.deepEqual(questionAnswers([{ question: 'Why?' }], ['because']), { 'Why?': 'because' })
  assert.deepEqual(
    questionAnswers([{ question: 'Which?' }, { question: 'When?' }], ['Blue', 'tomorrow']),
    { 'Which?': 'Blue', 'When?': 'tomorrow' },
  )
  // A short answer narrows to the question it reaches and falls back to the
  // first option for the rest: it can never invent a choice.
  assert.deepEqual(questionAnswers([{ question: 'Which?', options: [{ label: 'Blue' }] }, { question: 'When?' }], ['Blue']), {
    'Which?': 'Blue',
    'When?': '',
  })
})

test('the live view shows a shell command and a search pattern, redacted; the stored summary still does not', () => {
  assert.equal(displaySummary('Bash', { command: 'pnpm test\n  --watch=false' }), 'pnpm test --watch=false')
  assert.equal(displaySummary('Grep', { pattern: 'questionThinCards' }), 'questionThinCards')
  assert.equal(displaySummary('Read', { file_path: '/tmp/a.ts' }), '/tmp/a.ts', 'an edit-family call is still its path')
  assert.equal(displaySummary('WebFetch', { url: 'https://example.com' }), undefined)
  assert.equal(displaySummary('Bash', { command: `echo ${'x'.repeat(500)}` })?.length, 300)
  assert.ok(!displaySummary('Bash', { command: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" x' })?.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'a token is redacted')
  for (const [command, leaked] of [
    ['curl -u alice:hunter2 https://x', 'hunter2'],
    ['mysql -phunter2 db', 'hunter2'],
    ['DB_PASSWORD=hunter2 node a.js', 'hunter2'],
    ['tool --password hunter2 run', 'hunter2'],
    ['tool --token=hunter2 run', 'hunter2'],
  ] as const) {
    const shown = displaySummary('Bash', { command }) ?? ''
    assert.ok(!shown.includes(leaked), `${command} -> ${shown}`)
    assert.ok(shown.length > 0)
  }
  assert.equal(displaySummary('Bash', { command: 'pnpm test -p foo' }), 'pnpm test -p foo', 'a plain flag is not a credential')
  // The stored event is unchanged: no command in it.
  assert.equal(summariseToolUse('Bash', { command: 'ls' }), undefined)
})

test('displayToolUses lines up with the tool.use events of the same message', () => {
  const message = {
    type: 'assistant',
    message: { content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.ts' } },
    ] },
  }
  assert.deepEqual(displayToolUses(message), ['git status', '/tmp/a.ts'])
  assert.equal(mapMessage(message, 'trn_1' as never, live, at).length, 2)
})
