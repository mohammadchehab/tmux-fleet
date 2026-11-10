#!/usr/bin/env node
/**
 * A stand-in for `cursor-agent`, so the adapter can be tested without spending a
 * cursor turn. It speaks the same stream-json lines the real CLI does, and it
 * records how it was called so a test can assert the arguments the adapter built.
 *
 * Invoked as `node fake-cursor-agent.mjs …`, so the test does not depend on an
 * executable bit.
 */

import { appendFileSync } from 'node:fs'

const CHAT_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const args = process.argv.slice(2)

const record = () => {
  const log = process.env.FAKE_CURSOR_LOG
  if (log) appendFileSync(log, `${JSON.stringify(args)}\n`)
  // Where the process was started, for a test that asserts the session's cwd.
  const cwdLog = process.env.FAKE_CURSOR_CWD_LOG
  if (cwdLog) appendFileSync(cwdLog, `${process.cwd()}\n`)
}

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

if (args[0] === 'create-chat') {
  record()
  process.stdout.write(`${CHAT_ID}\n`)
  process.exit(0)
}

record()

const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const prompt = args[args.length - 1] ?? ''
const model = flag('--model')
const sessionId = 'chat-session-1'

emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'Composer 2.5', permissionMode: 'default' })
emit({ type: 'user', message: prompt, session_id: sessionId })

if (prompt.includes('INTERRUPT')) {
  // Stay alive until killed, so the test can interrupt a live turn.
  setInterval(() => {}, 1_000)
  process.on('SIGTERM', () => process.exit(0))
} else if (prompt.includes('CRASH')) {
  process.stderr.write('boom\n')
  process.exit(3)
} else if (prompt.includes('FAIL')) {
  emit({ type: 'result', subtype: 'error', is_error: true, duration_ms: 12, result: 'the model refused', session_id: sessionId })
  process.exit(1)
} else {
  emit({ type: 'tool_call', subtype: 'started', call_id: 'call-1', tool_call: { shellToolCall: { command: 'rg TODO' } } })
  emit({ type: 'tool_call', subtype: 'completed', call_id: 'call-1', tool_call: { shellToolCall: { command: 'rg TODO' } } })
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `read-only from ${model ?? 'no model'}` }] },
    session_id: sessionId,
  })
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 34,
    result: `read-only from ${model ?? 'no model'}`,
    session_id: sessionId,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 1 },
  })
  process.exit(0)
}
