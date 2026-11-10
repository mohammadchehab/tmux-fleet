// Does init.permissionMode echo the requested mode, and if not, why?
// Hypothesis under test (architect): user settings (permissions.defaultMode in ~/.claude/settings*.json)
// override the requested mode. Matrix isolates settings, then varies the request.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const WORK = mkdtempSync(join(tmpdir(), 'mode-probe-'))
delete process.env.CI

function childEnv(provider) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('ANTHROPIC_') || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k]
  }
  delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (provider === 'deepinfra') {
    const key = readFileSync(join(process.env.HOME, '.config/deepinfra/key'), 'utf8').split('\n')[0].trim()
    env.ANTHROPIC_BASE_URL = 'https://api.deepinfra.com/anthropic'
    env.ANTHROPIC_AUTH_TOKEN = key
    env.ANTHROPIC_API_KEY = ''
    env.ANTHROPIC_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
    env.ANTHROPIC_SMALL_FAST_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
  }
  return env
}

function input() {
  const q = []
  let resolve = null, ended = false
  const stream = (async function* () {
    for (;;) {
      if (q.length) { yield q.shift(); continue }
      if (ended) return
      await new Promise((r) => (resolve = r))
    }
  })()
  return {
    stream,
    push: (t) => { q.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); resolve?.() },
    end: () => { ended = true; resolve?.() },
  }
}

async function run(label, provider, mode, extra, prompt) {
  const q = input()
  const canUseTool = []
  const qq = query({
    prompt: q.stream,
    options: {
      cwd: WORK, env: childEnv(provider), includePartialMessages: false,
      permissionMode: mode, maxTurns: 2,
      canUseTool: async (toolName, input) => {
        canUseTool.push(toolName)
        return { behavior: 'deny', message: `mode-probe denies ${toolName}` }
      },
      ...extra,
    },
  })
  let initMode = null, initModel = null, resultText = null, denied = 0
  q.push(prompt)
  for await (const m of qq) {
    if (m.type === 'system' && m.subtype === 'init' && initMode === null) {
      initMode = m.permissionMode; initModel = m.model
    }
    if (m.type === 'result') {
      resultText = (m.result || '').slice(0, 80)
      denied = (m.permission_denials || []).length
      break
    }
  }
  q.end()
  return { label, provider, requested: mode, initMode, initModel, canUseToolCalls: canUseTool, permissionsDenied: denied, result: resultText,
           settings_isolated: Array.isArray(extra.settingSources) && extra.settingSources.length === 0 }
}

const ASK_WRITE = 'Use the Bash tool to run `touch ' + WORK + '/probe-write`, then reply DONE.'
const ASK_QUIET = 'Reply with exactly MODE_OK and nothing else.'

const results = []
// A: requested 'default', settings NOT isolated  (control for the settings hypothesis)
results.push(await run('A_default_no-isolation', 'claude', 'default', {}, ASK_QUIET))
// B: requested 'default', settings isolated (settingSources: [])
results.push(await run('B_default_isolated', 'claude', 'default', { settingSources: [] }, ASK_QUIET))
// C/D: does the echo track any request at all? vary the request under the same isolation.
results.push(await run('C_plan_isolated', 'claude', 'plan', { settingSources: [] }, ASK_QUIET))
results.push(await run('D_acceptEdits_isolated', 'claude', 'acceptEdits', { settingSources: [] }, ASK_QUIET))
// E: explicit settings object on top of isolation
results.push(await run('E_default_isolated_explicitSettings', 'claude', 'default',
  { settingSources: [], settings: { permissions: { defaultMode: 'default' } } }, ASK_QUIET))
// F: behavioural check under isolation — does a write reach canUseTool in the mode we asked for?
results.push(await run('F_default_isolated_write', 'claude', 'default', { settingSources: [] }, ASK_WRITE))
// G: same request as B on the other provider
results.push(await run('G_default_isolated_deepinfra', 'deepinfra', 'default', { settingSources: [] }, ASK_QUIET))

console.log(JSON.stringify({ probe: 'mode-echo', work: WORK, results }, null, 1))
