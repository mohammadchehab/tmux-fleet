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
  const provider = new CursorProvider({ executable: process.execPath, executableArgs: [FAKE], contextLimits: { [MODEL]: 200_000 } })
  const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
    peerId: 'architect' as PeerId,
    role: 'architect',
    cwd: dir,
    model: MODEL,
    permissionMode: 'plan',
    env: { FAKE_CURSOR_LOG: log },
    brief: { briefId: 'brf_00000000000000aa' as SessionSpec['brief']['briefId'], version: 1, contractVersions: [], text: 'Review the design.' },
    ...over,
  })
  const calls = (): readonly (readonly string[])[] =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as string[]) : []
  return { provider, spec, calls }
}

test('attachCommand opens cursor-agent on the same chat, in plan mode, on the peer\'s model', () => {
  const { provider, spec } = setup()
  assert.deepEqual(provider.attachCommand(CHAT, spec()), {
    executable: process.execPath,
    args: [FAKE, '--resume', CHAT, '--mode', 'plan', '--model', MODEL],
  })
})

test('a resume with an opening sends the handback note as its first turn, not the brief (§4)', async () => {
  const { provider, spec, calls } = setup()
  const handle = await provider.resume(CHAT, spec({ opening: 'A person held this chat. Carry on from the conversation.' }))
  for await (const event of provider.events(handle)) {
    if (event.type === 'turn.ended') break
  }
  const turn = calls().at(-1) ?? []
  assert.equal(turn.at(-1), 'A person held this chat. Carry on from the conversation.')
  assert.ok(!turn.some((arg) => arg.includes('Review the design.')), 'the brief is not sent again')
  await provider.stop(handle)
})
