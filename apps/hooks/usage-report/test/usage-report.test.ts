import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { callDaemon } from '../src/client.ts'
import { buildReport, readStopPayload } from '../src/report.ts'
import { measureTurn } from '../src/transcript.ts'

const line = (value: unknown): string => JSON.stringify(value)
const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } })
const toolResult = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })
const assistant = (id: string, usage: object, tools: string[] = []) =>
  line({
    type: 'assistant',
    message: { id, role: 'assistant', usage, content: [{ type: 'text', text: 'x' }, ...tools.map((name) => ({ type: 'tool_use', id: `u-${name}`, name, input: {} }))] },
  })

const transcript = [
  prompt('an earlier turn'),
  assistant('m0', { input_tokens: 9999, output_tokens: 9999 }, ['Grep']),
  prompt('this turn'),
  assistant('m1', { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, ['Grep', 'Read', 'mcp__codegraph__codegraph_explore']),
  toolResult,
  // the same message written again while streaming: the last copy wins, and it is counted once
  assistant('m2', { input_tokens: 5, output_tokens: 1 }),
  assistant('m2', { input_tokens: 20, output_tokens: 80, cache_read_input_tokens: 1300, cache_creation_input_tokens: 0 }, ['Read', 'Glob', 'Bash']),
  'not json at all',
].join('\n')

describe('measureTurn', () => {
  it('counts only the turn after the last real prompt, and a tool result is not a prompt', () => {
    const m = measureTurn(transcript)
    assert.deepEqual(m?.toolCalls, { grep: 1, glob: 1, read: 2, codegraph: 1 })
    assert.equal(m?.inputTokens, 30)
    assert.equal(m?.outputTokens, 130)
    assert.equal(m?.cachedTokens, 2300)
  })

  it('takes the context from the last call of the turn', () => {
    assert.equal(measureTurn(transcript)?.contextTokens, 20 + 1300 + 0)
  })

  it('has nothing to say about a turn with no assistant message, and survives garbage', () => {
    assert.equal(measureTurn(prompt('hello')), undefined)
    assert.equal(measureTurn('{{{\n\n[1,2]'), undefined)
  })

  it('ignores side chains and clamps nonsense numbers', () => {
    const side = line({ type: 'assistant', isSidechain: true, message: { id: 's', usage: { input_tokens: 500 }, content: [] } })
    const odd = assistant('m', { input_tokens: -4, output_tokens: 'lots' })
    const m = measureTurn([prompt('p'), side, odd].join('\n'))
    assert.deepEqual([m?.inputTokens, m?.outputTokens], [0, 0])
  })
})

const env = { FLEET_PEER: 'engineer-1', FLEET_CONTEXT_LIMIT: '200000', FLEET_SOCKET: '/tmp/none.sock' }

describe('buildReport', () => {
  it('builds the usage request from the transcript and the environment', () => {
    const r = buildReport({ stopHookActive: false }, transcript, { ...env, FLEET_WORK_ID: 'wrk_7f3a91c2d84b0e56' })
    assert.ok(r.status === 'report')
    assert.equal(r.params.peerId, 'engineer-1')
    assert.equal(r.params.contextLimit, 200000)
    assert.equal(r.params.workId, 'wrk_7f3a91c2d84b0e56')
    assert.equal(r.params.toolCalls.codegraph, 1)
  })

  it('skips, with the reason, rather than inventing a missing context limit', () => {
    for (const bad of [undefined, '', '0', '-5', 'many', '1.5']) {
      const r = buildReport({ stopHookActive: false }, transcript, { ...env, FLEET_CONTEXT_LIMIT: bad })
      assert.ok(r.status === 'skip' && /FLEET_CONTEXT_LIMIT/.test(r.reason), String(bad))
    }
  })

  it('skips outside the fleet, on a repeated Stop, and without a transcript', () => {
    assert.match(String((buildReport({ stopHookActive: false }, transcript, { ...env, FLEET_PEER: 'Not A Peer!' }) as { reason?: string }).reason), /FLEET_PEER/)
    assert.match(String((buildReport({ stopHookActive: true }, transcript, env) as { reason?: string }).reason), /already active/)
    assert.match(String((buildReport({ stopHookActive: false }, undefined, env) as { reason?: string }).reason), /no transcript/)
  })

  it('leaves out a work id that is not one', () => {
    const r = buildReport({ stopHookActive: false }, transcript, { ...env, FLEET_WORK_ID: 'whatever' })
    assert.ok(r.status === 'report' && r.params.workId === undefined)
  })
})

describe('readStopPayload', () => {
  it('reads the transcript path and the repeat flag, and tolerates junk', () => {
    assert.deepEqual(readStopPayload('{"transcript_path":"/t.jsonl","stop_hook_active":true,"x":1}'), { transcriptPath: '/t.jsonl', stopHookActive: true })
    assert.deepEqual(readStopPayload('nope'), { stopHookActive: false })
    assert.deepEqual(readStopPayload('[]'), { stopHookActive: false })
  })
})

const listen = async (respond: (request: string) => string | undefined) => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'))
  const path = join(dir, 's.sock')
  const requests: string[] = []
  const server: Server = createServer((socket) => {
    let buf = ''
    socket.on('data', (d) => {
      buf += d.toString()
      if (!buf.includes('\n')) return
      requests.push(buf.trim())
      const reply = respond(buf.trim())
      if (reply !== undefined) socket.write(`${reply}\n`)
    })
  })
  await new Promise<void>((r) => server.listen(path, r))
  return { path, requests, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe('callDaemon', () => {
  it('sends one line and reads the answer', async () => {
    const d = await listen(() => '{"id":"usage","ok":true,"result":{"recorded":true}}')
    const reply = await callDaemon(d.path, 'usage', { a: 1 })
    assert.equal(reply.ok, true)
    assert.deepEqual(JSON.parse(d.requests[0] ?? ''), { id: 'usage', method: 'usage', params: { a: 1 } })
    await d.close()
  })

  it('reports a refusal, a dead socket and a silent daemon without throwing or hanging', async () => {
    const refusing = await listen(() => '{"ok":false,"error":{"code":"not_found","message":"no peer x"}}')
    assert.deepEqual(await callDaemon(refusing.path, 'usage', {}), { ok: false, message: 'no peer x' })
    await refusing.close()

    const dead = await callDaemon('/tmp/definitely-not-a-socket.sock', 'usage', {})
    assert.equal(dead.ok, false)

    const silent = await listen(() => undefined)
    const started = Date.now()
    const reply = await callDaemon(silent.path, 'usage', {}, 150)
    assert.equal(reply.ok, false)
    assert.ok(Date.now() - started < 1500)
    await silent.close()
  })
})

describe('the hook entry', () => {
  it('reads the Stop payload, reports to the daemon, and exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-main-'))
    const file = join(dir, 't.jsonl')
    await writeFile(file, transcript)
    const d = await listen(() => '{"ok":true,"result":{"recorded":true}}')
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname], {
        env: { ...process.env, ...env, FLEET_SOCKET: d.path },
      })
      child.on('close', resolve)
      child.stdin.end(JSON.stringify({ transcript_path: file, stop_hook_active: false }))
    })
    assert.equal(code, 0)
    const sent = JSON.parse(d.requests[0] ?? '{}') as { method: string; params: { peerId: string; outputTokens: number } }
    assert.equal(sent.method, 'usage')
    assert.equal(sent.params.peerId, 'engineer-1')
    assert.equal(sent.params.outputTokens, 130)
    await d.close()
  })

  it('exits 0 even when it cannot report', async () => {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname], { env: { PATH: process.env['PATH'] ?? '' } })
      child.on('close', resolve)
      child.stdin.end('garbage')
    })
    assert.equal(code, 0)
  })
})
