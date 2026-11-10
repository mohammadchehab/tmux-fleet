#!/usr/bin/env node
// Throwaway spike probe for fleet v2 §4 Provider interface.
// Usage: node probe.mjs <probe> <claude|deepinfra> [--json]
// Probes: events usage question interrupt permission model resume-write resume-read
//
// Every probe prints one JSON object prefixed with "PROBE_RESULT " so a wrapper
// can capture structured evidence from each provider run.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, 'work')
const DEEPINFRA_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

const [probe, provider = 'claude'] = process.argv.slice(2)
if (!probe || !['claude', 'deepinfra'].includes(provider)) {
  console.error('usage: probe.mjs <probe> <claude|deepinfra>')
  process.exit(2)
}

// The SDK passes `options.env` as the child's WHOLE environment (the docs tell
// you to spread process.env yourself), so we build it explicitly and drop every
// inherited Anthropic/Claude-Code variable. Without this, a parent session that
// runs on DeepInfra would silently make the "claude" run use DeepInfra too.
function childEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('ANTHROPIC_') || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k]
  }
  delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (provider === 'deepinfra') {
    const key = process.env.DEEPINFRA_API_KEY?.trim() ||
      readFileSync(join(process.env.HOME || '', '.config/deepinfra/key'), 'utf8').split('\n')[0].trim()
    env.ANTHROPIC_BASE_URL = 'https://api.deepinfra.com/anthropic'
    env.ANTHROPIC_AUTH_TOKEN = key
    env.ANTHROPIC_API_KEY = ''
    env.ANTHROPIC_MODEL = DEEPINFRA_MODEL
    env.ANTHROPIC_SMALL_FAST_MODEL = DEEPINFRA_MODEL
  }
  return env
}

function baseOptions(extra = {}) {
  const opts = {
    cwd: WORK,
    env: childEnv(),
    settingSources: [],           // no user/project settings: the spike measures the SDK, not my setup
    includePartialMessages: false,
  }
  if (provider === 'deepinfra') opts.model = DEEPINFRA_MODEL
  return { ...opts, ...extra }
}

// Streaming-input queue, needed for multi-turn, interrupt and mid-session mode changes.
function inputQueue() {
  const pending = []
  let wake = null
  let ended = false
  const push = (text) => {
    const msg = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    if (wake) { const w = wake; wake = null; w({ value: msg, done: false }) } else pending.push(msg)
  }
  const end = () => {
    ended = true
    if (wake) { const w = wake; wake = null; w({ value: undefined, done: true }) }
  }
  return {
    push, end,
    stream: {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (pending.length) return Promise.resolve({ value: pending.shift(), done: false })
        if (ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((r) => { wake = r })
      },
      return() { ended = true; return Promise.resolve({ value: undefined, done: true }) },
    },
  }
}

const t0 = Date.now()
const ms = () => Date.now() - t0
const log = []
const say = (...a) => { const line = a.join(' '); log.push(line); console.log(line) }
function emit(evidence) {
  console.log('PROBE_RESULT ' + JSON.stringify({ probe, provider, evidence }))
}

// A compact, human-readable summary of every stream message.
function describe(m, state) {
  const out = { at: ms(), type: m.type, subtype: m.subtype }
  if (m.type === 'system' && m.subtype === 'init') {
    Object.assign(out, {
      model: m.model, permissionMode: m.permissionMode, session_id: m.session_id,
      apiKeySource: m.apiKeySource, claude_code_version: m.claude_code_version,
      capabilities: m.capabilities,
    })
  }
  if (m.type === 'system' && m.subtype === 'session_state_changed') out.state = m.state
  if (m.type === 'system' && m.subtype === 'status') {
    out.status = m.status; out.permissionMode = m.permissionMode
  }
  if (m.type === 'system' && m.subtype === 'compact_boundary') out.compact = m.compact_metadata
  if (m.type === 'assistant') {
    const msg = m.message || {}
    out.message_model = msg.model
    out.usage = msg.usage && {
      input_tokens: msg.usage.input_tokens,
      cache_read_input_tokens: msg.usage.cache_read_input_tokens,
      cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
      output_tokens: msg.usage.output_tokens,
    }
    const blocks = Array.isArray(msg.content) ? msg.content : []
    out.blocks = blocks.map((b) => b.type === 'tool_use' ? `tool_use:${b.name}` : b.type)
    out.stop_reason = msg.stop_reason
  }
  if (m.type === 'user') {
    const c = m.message?.content
    out.blocks = Array.isArray(c) ? c.map((b) => b.type) : ['text']
  }
  if (m.type === 'result') {
    Object.assign(out, {
      is_error: m.is_error, num_turns: m.num_turns, cost_usd: m.total_cost_usd,
      stop_reason: m.stop_reason, terminal_reason: m.terminal_reason,
      result_text: (m.result || '').slice(0, 400),
      modelUsage: m.modelUsage,
      permission_denials: m.permission_denials,
      usage: m.usage && {
        input_tokens: m.usage.input_tokens,
        output_tokens: m.usage.output_tokens,
        cache_read_input_tokens: m.usage.cache_read_input_tokens,
        cache_creation_input_tokens: m.usage.cache_creation_input_tokens,
      },
    })
  }
  return out
}

// ---------------------------------------------------------------------------

async function probeEvents() {
  const q = inputQueue()
  const seen = []
  const calls = []
  const qq = query({
    prompt: q.stream,
    options: baseOptions({
      maxTurns: 4,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      canUseTool: async (toolName, input) => {
        calls.push({ at: ms(), toolName, inputKeys: Object.keys(input || {}) })
        return { behavior: 'allow', updatedInput: input }
      },
    }),
  })
  q.push('Turn 1: use the Bash tool to run `echo hi`, then reply T1_DONE. Keep it to one tool call.')
  let results = 0
  for await (const m of qq) {
    seen.push(describe(m))
    if (m.type === 'result') {
      results++
      if (results === 1) {
        // turn boundary: read usage at the boundary, exactly what self-purge (§8) needs
        let ctx = null
        try { ctx = await qq.getContextUsage({ detail: 'summary' }) } catch (e) { ctx = { error: String(e) } }
        currentContext = ctx
        q.push('Turn 2: reply with exactly T2_DONE and nothing else.')
      } else if (results === 2) {
        let ctx2 = null
        try { ctx2 = await qq.getContextUsage({ detail: 'summary' }) } catch (e) { ctx2 = { error: String(e) } }
        secondContext = ctx2
        q.end()
      }
    }
  }
  return {
    message_sequence: seen.map((s) => `${s.type}${s.subtype ? '/' + s.subtype : ''}`),
    message_types_present: [...new Set(seen.map((s) => s.type))],
    system_subtypes_present: [...new Set(seen.filter((s) => s.type === 'system').map((s) => s.subtype))],
    canUseTool_calls: calls,
    init: seen.find((s) => s.subtype === 'init'),
    turn_boundaries: seen.filter((s) => s.type === 'result'),
    context_usage_turn1: compactContext(currentContext),
    context_usage_turn2: compactContext(secondContext),
    messages: seen,
  }
}
let currentContext = null, secondContext = null
function compactContext(ctx) {
  if (!ctx || ctx.error) return ctx
  const sum = (k) => (ctx.categories || []).filter((c) => c.kind === k).reduce((a, c) => a + c.tokens, 0)
  return {
    model: ctx.model, totalTokens: ctx.totalTokens, maxTokens: ctx.maxTokens,
    rawMaxTokens: ctx.rawMaxTokens, percentage: ctx.percentage,
    used: sum('used'), free: sum('free'), buffer: sum('buffer'), deferred: sum('deferred'),
    categories: (ctx.categories || []).map((c) => `${c.kind}:${c.id ?? c.name}=${c.tokens}`),
  }
}
async function probeUsage() {
  const q = inputQueue()
  const qq = query({
    prompt: q.stream,
    options: baseOptions({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, maxTurns: 2 }),
  })
  q.push('Reply with exactly USAGE_OK.')
  const out = { samples: [] }
  let n = 0
  for await (const m of qq) {
    if (m.type === 'result') {
      n++
      const snap = (ctx) => ctx && ctx.error ? ctx : ctx && {
        model: ctx.model, totalTokens: ctx.totalTokens, maxTokens: ctx.maxTokens,
        rawMaxTokens: ctx.rawMaxTokens, percentage: ctx.percentage,
        messages_row: (ctx.categories || []).find((c) => c.id === 'messages')?.tokens,
        used: (ctx.categories || []).filter((c) => c.kind === 'used').reduce((a, c) => a + c.tokens, 0),
        free: (ctx.categories || []).find((c) => c.kind === 'free')?.tokens,
        buffer: (ctx.categories || []).find((c) => c.kind === 'buffer')?.tokens,
      }
      const full = await qq.getContextUsage({ detail: 'full' }).catch((e) => ({ error: String(e) }))
      const summary = await qq.getContextUsage({ detail: 'summary' }).catch((e) => ({ error: String(e) }))
      out.samples.push({
        turn: n,
        result_usage: m.usage,
        result_modelUsage: m.modelUsage,
        result_total_cost_usd: m.total_cost_usd,
        getContextUsage_full: snap(full),
        getContextUsage_summary: snap(summary),
      })
      if (n === 1) q.push('Write a 150-word paragraph about the colour blue, then stop.')
      else q.end()
    }
  }
  return out
}

async function probeQuestion() {
  const q = inputQueue()
  const calls = []
  const qq = query({
    prompt: q.stream,
    options: baseOptions({
      maxTurns: 3,
      permissionMode: 'default',           // NOT bypass: we want the question to reach canUseTool
      canUseTool: async (toolName, input) => {
        calls.push({ at: ms(), toolName, input })
        if (toolName === 'AskUserQuestion') {
          const answers = {}
          for (const qu of input.questions || []) answers[qu.question] = qu.options?.[0]?.label ?? 'first'
          return { behavior: 'allow', updatedInput: { ...input, answers } }
        }
        return { behavior: 'allow', updatedInput: input }
      },
    }),
  })
  q.push('Use the AskUserQuestion tool to ask me which deployment channel I prefer, with options "Blue" and "Green". Ask exactly one question. Then stop.')
  const seen = []
  let askedAt = null, answeredAt = null
  let n = 0
  for await (const m of qq) {
    seen.push(describe(m))
    if (m.type === 'result') { n++; if (n === 1) q.end() }
  }
  askedAt = calls.find((c) => c.toolName === 'AskUserQuestion')?.at ?? null
  return {
    asked_at_ms: askedAt,
    canUseTool_calls: calls.map((c) => ({ at: c.at, toolName: c.toolName, input: c.toolName === 'AskUserQuestion' ? c.input : c.input })),
    session_state_changed: seen.filter((s) => s.subtype === 'session_state_changed'),
    message_sequence: seen.map((s) => `${s.type}${s.subtype ? '/' + s.subtype : ''}`),
    assistant_tool_uses: seen.filter((s) => s.blocks).flatMap((s) => s.blocks).filter((b) => String(b).startsWith('tool_use:')),
    result: seen.find((s) => s.type === 'result'),
  }
}

async function probePermission() {
  // (a) default mode: a write tool MUST come through canUseTool; we deny it.
  const q = inputQueue()
  const calls = []
  const seenA = []
  let modeAtStart = null, setModeDefaultToAccept = null, setModeBypass = null
  const qq = query({
    prompt: q.stream,
    options: baseOptions({
      maxTurns: 4,
      permissionMode: 'default',
      canUseTool: async (toolName, input) => {
        calls.push({ at: ms(), toolName, command: input?.command })
        return toolName === 'Bash'
          ? { behavior: 'deny', message: 'spike denies Bash in default mode' }
          : { behavior: 'allow', updatedInput: input }
      },
    }),
  })
  q.push('Use the Bash tool to run `touch /tmp/fleet-sdk-spike/work/perm-default`, then reply MODE_DONE.')
  let n = 0
  for await (const m of qq) {
    seenA.push(describe(m))
    if (m.type === 'system' && m.subtype === 'init') modeAtStart = m.permissionMode
    if (m.type === 'result') {
      n++
      if (n === 1) {
        try { await qq.setPermissionMode('acceptEdits'); setModeDefaultToAccept = 'ok' } catch (e) { setModeDefaultToAccept = String(e) }
        try { await qq.setPermissionMode('bypassPermissions'); setModeBypass = 'ok' } catch (e) { setModeBypass = String(e) }
        q.push('Reply with exactly SECOND_TURN.')
      } else if (n === 2) q.end()
    }
  }
  const defaultDenied = seenA.some((s) => s.blocks?.includes('tool_result')) && calls.length > 0

  // (b) a session launched with allowDangerouslySkipPermissions in bypass mode:
  // canUseTool must never fire and the tool must run unattended.
  const bypassCalls = []
  const seenB = []
  const qb = inputQueue()
  const qbq = query({
    prompt: qb.stream,
    options: baseOptions({
      maxTurns: 2, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
      canUseTool: async (toolName, input) => { bypassCalls.push(toolName); return { behavior: 'allow', updatedInput: input } },
    }),
  })
  qb.push('Use the Bash tool to run `touch /tmp/fleet-sdk-spike/work/perm-bypass`, then reply BYPASS_DONE.')
  for await (const m of qbq) {
    seenB.push(describe(m))
    if (m.type === 'result') qb.end()
  }
  return {
    default: {
      init_permissionMode: modeAtStart,
      canUseTool_calls: calls,
      assistant_tool_uses: seenA.flatMap((s) => s.blocks || []).filter((b) => String(b).startsWith('tool_use:')),
      results: seenA.filter((s) => s.type === 'result').map((s) => ({ text: s.result_text, denials: s.permission_denials })),
      denied_and_model_saw_it: defaultDenied,
      setPermissionMode_default_to_acceptEdits: setModeDefaultToAccept,
      setPermissionMode_to_bypassPermissions: setModeBypass,
    },
    bypass: {
      canUseTool_calls: bypassCalls,
      assistant_tool_uses: seenB.flatMap((s) => s.blocks || []).filter((b) => String(b).startsWith('tool_use:')),
      results: seenB.filter((s) => s.type === 'result').map((s) => ({ text: s.result_text })),
    },
  }
}

async function probeInterrupt() {
  const q = inputQueue()
  const seen = []
  const ac = new AbortController()
  const qq = query({
    prompt: q.stream,
    options: baseOptions({ maxTurns: 4, permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true, abortController: ac }),
  })
  q.push('Run this Bash command and wait for it: `node -e "const t=Date.now(); while(Date.now()-t<40000){}"`. Then reply SLEPT. Use exactly one Bash call and do not background it.')
  let interruptedAt = null, interruptResult = null, resultsAfter = 0
  let endedByItself = false
  const timer = setTimeout(async () => {
    interruptedAt = ms()
    try { interruptResult = await qq.interrupt() } catch (e) { interruptResult = { error: String(e) } }
    // The async iterator does NOT finish on interrupt (it waits for more input);
    // close the input side and give the CLI a bounded time to wind down.
    setTimeout(() => { q.end(); ac.abort() }, 5000)
  }, 5000)
  const hardStop = setTimeout(() => { try { q.end(); ac.abort() } catch {} }, 45000)
  try {
    for await (const m of qq) {
      seen.push(describe(m))
      if (m.type === 'result') resultsAfter++
    }
    endedByItself = true
  } catch (e) {
    seen.push({ type: 'iterator_error', error: String(e) })
  }
  clearTimeout(timer); clearTimeout(hardStop)
  return {
    interrupted_at_ms: interruptedAt,
    interrupt_return: interruptResult,
    iterator_ended_when: endedByItself ? 'stream finished' : 'abort/end input',
    results_after_interrupt: resultsAfter,
    message_sequence: seen.map((s) => `${s.at}ms ${s.type}${s.subtype ? '/' + s.subtype : ''}`),
    last_messages: seen.slice(-5),
  }
}

async function probeModel() {
  const q = inputQueue()
  const qq = query({
    prompt: q.stream,
    options: baseOptions({ maxTurns: 2, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }),
  })
  q.push('Reply with exactly MODEL_OK.')
  const out = { init: null, assistant_models: [], result_modelUsage: null, session_id: null }
  let n = 0
  for await (const m of qq) {
    if (m.type === 'system' && m.subtype === 'init') {
      out.init = { model: m.model, permissionMode: m.permissionMode, session_id: m.session_id, apiKeySource: m.apiKeySource }
    }
    if (m.type === 'assistant') out.assistant_models.push(m.message?.model)
    if (m.type === 'result') {
      out.result_modelUsage = m.modelUsage
      out.session_id = m.session_id
      if (n === 0) { n++; q.end() }
    }
  }
  out.env_model_requested = provider === 'deepinfra' ? DEEPINFRA_MODEL : '(none: SDK default)'
  return out
}

// Force an early auto-compact by shrinking the window in the child's env only:
// this is what a Provider adapter would do to test the compaction event cheaply.
async function probeCompaction() {
  // Auto-compaction cannot be forced cheaply (the window is clamped to >=100k),
  // so we drive the same path with the CLI's /compact local command, which emits
  // the same SDKCompactBoundaryMessage. Auto-compaction differs only in `trigger`.
  const q = inputQueue()
  const seen = []
  const qq = query({
    prompt: q.stream,
    options: baseOptions({ maxTurns: 6, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }),
  })
  q.push('Say hello in five words.')
  let n = 0
  const deadline = setTimeout(() => { try { q.end() } catch {} }, 120000)
  for await (const m of qq) {
    seen.push(describe(m))
    if (m.type === 'result') {
      n++
      if (n === 1) q.push('/compact')
      else if (n === 2) q.push('Reply with exactly AFTER_COMPACT.')
      else q.end()
    }
  }
  clearTimeout(deadline)
  return {
    how_forced: 'stream-json user message "/compact" (auto-compaction differs only in compact_metadata.trigger)',
    compaction_events: seen.filter((s) => s.subtype === 'compact_boundary').map((s) => ({ at: s.at, compact: s.compact })),
    status_messages: seen.filter((s) => s.subtype === 'status').map((s) => s.status),
    message_sequence: seen.map((s) => `${s.type}${s.subtype ? '/' + s.subtype : ''}`),
    results: seen.filter((s) => s.type === 'result').map((s) => ({ text: (s.result_text || '').slice(0, 60), is_error: s.is_error })),
  }
}

// Mid-session model switch (capabilities.modelSwitch) and structured output
// (capabilities.structuredOutput), both of which the Provider interface names.
async function probeSwitch() {
  const q = inputQueue()
  const qq = query({
    prompt: q.stream,
    options: baseOptions({ maxTurns: 4, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }),
  })
  q.push('Reply with exactly ONE.')
  const out = { turns: [] }
  let n = 0
  for await (const m of qq) {
    if (m.type === 'assistant' && m.message?.model) out.turns.push({ at: ms(), assistant_model: m.message.model })
    if (m.type === 'result') {
      n++
      if (n === 1) {
        const target = process.env.PROBE_SWITCH_MODEL || (provider === 'deepinfra' ? DEEPINFRA_MODEL : 'claude-haiku-4-5-20251001')
        out.switched_to = target
        try { await qq.setModel(target); out.setModel = 'ok' } catch (e) { out.setModel = String(e) }
        q.push('Reply with exactly TWO.')
      } else if (n === 2) {
        out.modelUsage_after_switch = Object.keys(m.modelUsage)
        q.end()
      }
    }
  }
  return out
}

async function probeStructured() {
  const q = inputQueue()
  const qq = query({
    prompt: q.stream,
    options: baseOptions({
      maxTurns: 2, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['ok'] }, count: { type: 'integer' } },
          required: ['status', 'count'], additionalProperties: false,
        },
      },
    }),
  })
  q.push('Report status ok and count 3.')
  const seen = []
  for await (const m of qq) {
    seen.push({ at: ms(), type: m.type, subtype: m.subtype })
    if (m.type === 'result') {
      return {
        result_keys: Object.keys(m),
        structured_output: m.structured_output ?? null,
        result_text: m.result,
        message_sequence: seen.map((x) => `${x.type}${x.subtype ? '/' + x.subtype : ''}`),
      }
    }
  }
  return { error: 'no result' }
}

// resume in two processes: the wrapper runs "resume-write" then "resume-read" and
// passes the captured session id through a file.
async function probeResumeWrite() {
  const q = inputQueue()
  const qq = query({
    prompt: q.stream,
    options: baseOptions({ maxTurns: 1, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }),
  })
  q.push('Remember this secret phrase for later: PURPLE-OTTER-4417. Reply with exactly REMEMBERED.')
  let sid = null, result = null
  for await (const m of qq) {
    if (m.type === 'system' && m.subtype === 'init') sid = m.session_id
    if (m.type === 'result') { result = { text: m.result, is_error: m.is_error, modelUsage: m.modelUsage }; q.end() }
  }
  if (sid) writeFileSync(join(HERE, 'work', `.sid-${provider}`), sid + '\n')
  return { session_id: sid, turn1: result }
}

async function probeResumeRead() {
  const sid = readFileSync(join(HERE, 'work', `.sid-${provider}`), 'utf8').trim()
  const q = inputQueue()
  const qq = query({
    prompt: q.stream,
    options: baseOptions({ resume: sid, maxTurns: 1, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }),
  })
  q.push('What was the secret phrase I asked you to remember? Reply with just the phrase.')
  let init = null, result = null, firstUserBlocks = []
  for await (const m of qq) {
    if (m.type === 'system' && m.subtype === 'init') init = { session_id: m.session_id, model: m.model }
    if (m.type === 'user' && firstUserBlocks.length < 3) firstUserBlocks.push({ subtype: m.subtype, isReplay: m.isReplay })
    if (m.type === 'result') { result = { text: m.result, is_error: m.is_error, modelUsage: m.modelUsage }; q.end() }
  }
  return {
    requested_resume_id: sid,
    init,
    context_intact: /PURPLE-OTTER-4417/i.test(result?.text || ''),
    answer: result,
  }
}

// ---------------------------------------------------------------------------

const probes = {
  events: probeEvents,
  usage: probeUsage,
  question: probeQuestion,
  permission: probePermission,
  interrupt: probeInterrupt,
  model: probeModel,
  compaction: probeCompaction,
  switch: probeSwitch,
  structured: probeStructured,
  'resume-write': probeResumeWrite,
  'resume-read': probeResumeRead,
}

const WATCHDOG_MS = Number(process.env.PROBE_WATCHDOG_MS || 90000)
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: probe exceeded ' + WATCHDOG_MS + 'ms')
  process.exit(3)
}, WATCHDOG_MS)
watchdog.unref?.()

const fn = probes[probe]
if (!fn) { console.error('unknown probe', probe); process.exit(2) }
let evidence
try {
  evidence = await fn()
} catch (e) {
  evidence = { fatal_error: String(e && e.stack || e) }
  process.exitCode = 1
}
say('\n--- probe:', probe, '/', provider, '---')
say('elapsed_ms', ms())
emit(evidence)
