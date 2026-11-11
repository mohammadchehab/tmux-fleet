/**
 * A takeover and its handback (watch-and-attach §4, §5): the CLI a person opens
 * on the session, and the first message of the session fleetd resumes after.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { newBriefId, type PeerId, type ProviderSessionRef } from '@fleet/foundation-core'
import type { SessionSpec } from '@fleet/runtime-provider-sdk'

import { openingMessage } from '../src/brief.ts'
import { ClaudeProvider } from '../src/provider.ts'

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  peerId: 'engineer-1' as PeerId,
  role: 'engineer',
  cwd: '/tmp',
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  env: {},
  brief: { briefId: newBriefId(), version: 3, contractVersions: [], text: 'Build the mailbox.' },
  ...over,
})

test('attachCommand opens interactive claude on the same session and the peer\'s model', () => {
  const ref = '1d61f8ce-5fe5-45cf-8273-3f06cab62c86' as ProviderSessionRef
  assert.deepEqual(new ClaudeProvider().attachCommand(ref, spec()), {
    executable: 'claude',
    args: ['--resume', ref, '--model', 'claude-opus-5-5'],
  })
})

test('a resume with an opening sends the handback note, not the brief again (§4)', () => {
  const turn = openingMessage(spec({ opening: 'A person held this session from 10:00 to 10:20. Carry on.' }))
  assert.equal(turn.text, 'A person held this session from 10:00 to 10:20. Carry on.')
  assert.doesNotMatch(turn.text, /Build the mailbox/)
  assert.equal(turn.kind, 'info')
  assert.equal(turn.briefVersion, 3, 'the note still cites the brief the session carries')
})

test('without an opening, the first message is still the brief', () => {
  assert.match(openingMessage(spec()).text, /Build the mailbox\./)
  assert.equal(openingMessage(spec()).kind, 'brief')
})
