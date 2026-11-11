/**
 * A takeover and its handback on a cursor chat (watch-and-attach §4, §5).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { PeerId, ProviderSessionRef } from '@fleet/foundation-core'
import type { SessionSpec } from '@fleet/runtime-provider-sdk'

import { CursorProvider } from '../src/provider.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-cursor-agent.mjs', import.meta.url))
const MODEL = 'composer-2.5'
const CHAT = '0f0e0d0c-0b0a-4908-8706-050403020100' as ProviderSessionRef

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cursor-attach-'))
  const log = join(dir, 'calls.jsonl')
  const promptsLog = join(dir, 'prompts.jsonl')
  const provider = new CursorProvider({ executable: process.execPath, executableArgs: [FAKE], contextLimits: { [MODEL]: 200_000 } })
  const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
    peerId: 'architect' as PeerId,
    role: 'architect',
    cwd: dir,
    model: MODEL,
    permissionMode: 'plan',
    env: { FAKE_CURSOR_LOG: log, FAKE_CURSOR_PROMPT_LOG: promptsLog },
    brief: { briefId: 'brf_00000000000000aa' as SessionSpec['brief']['briefId'], version: 1, contractVersions: [], text: 'Review the design.' },
    ...over,
  })
  const grid = (path: string): readonly (readonly string[])[] =>
    existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as string[]) : []
  const calls = () => grid(log)
  // The turn's text arrives on stdin, so it is read back from the fixture's log of
  // what it was handed — the argv on its own no longer carries a prompt.
  const prompts = (): readonly string[] =>
    existsSync(promptsLog) ? readFileSync(promptsLog, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as string) : []
  return { provider, spec, calls, prompts }
}

test('attachCommand opens cursor-agent on the same chat, in plan mode, on the peer\'s model', () => {
  const { provider, spec } = setup()
  assert.deepEqual(provider.attachCommand(CHAT, spec()), {
    executable: process.execPath,
    args: [FAKE, '--resume', CHAT, '--mode', 'plan', '--model', MODEL],
  })
})

test('a resume with an opening sends the handback note as its first turn, not the brief (§4)', async () => {
  const { provider, spec, calls, prompts } = setup()
  const handle = await provider.resume(CHAT, spec({ opening: 'A person held this chat. Carry on from the conversation.' }))
  for await (const event of provider.events(handle)) {
    if (event.type === 'turn.ended') break
  }
  assert.equal(prompts().at(-1), 'A person held this chat. Carry on from the conversation.')
  assert.ok(!prompts().some((text) => text.includes('Review the design.')), 'the brief is not sent again')
  const turn = calls().at(-1) ?? []
  assert.ok(!turn.some((arg) => arg.includes('A person held this chat.')), 'and the note is not on the command line')
  await provider.stop(handle)
})
