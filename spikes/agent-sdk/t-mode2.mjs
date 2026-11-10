// Follow-up: was the spike's "init.permissionMode said acceptEdits when I asked for default" a CLI quirk,
// or the probe's own capture variable being overwritten by the re-emitted init after setPermissionMode()?
// Records EVERY init permissionMode in order, around a mid-session switch.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const WORK = mkdtempSync(join(tmpdir(), 'mode-probe2-'))

function childEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('ANTHROPIC_') || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k]
  }
  delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  return env
}
function input() {
  const q = []; let resolve = null, ended = false
  const stream = (async function* () { for (;;) { if (q.length) { yield q.shift(); continue } if (ended) return; await new Promise((r) => (resolve = r)) } })()
  return { stream, push: (t) => { q.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); resolve?.() }, end: () => { ended = true; resolve?.() } }
}

const q = input()
const inits = []
const qq = query({
  prompt: q.stream,
  options: { cwd: WORK, env: childEnv(), settingSources: [], includePartialMessages: false, permissionMode: 'default', maxTurns: 4 },
})
q.push('Reply with exactly T1 and nothing else.')
let turn = 0, setResult = null
for await (const m of qq) {
  if (m.type === 'system' && m.subtype === 'init') inits.push({ at_turn: turn, permissionMode: m.permissionMode })
  if (m.type === 'result') {
    turn++
    if (turn === 1) {
      setResult = await qq.setPermissionMode('acceptEdits').then(() => 'ok', (e) => String(e))
      q.push('Reply with exactly T2 and nothing else.')
    } else break
  }
}
q.end()
console.log(JSON.stringify({ probe: 'init-sequence', requested: 'default', mid_session_switch_to: 'acceptEdits', setPermissionMode: setResult, inits }, null, 1))
