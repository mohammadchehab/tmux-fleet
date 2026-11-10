/**
 * The state file: the one structured thing a peer hands over (§8). What is
 * tested here is mostly refusal — the handoff is only as good as the schema's
 * willingness to say no.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PeerId } from '@fleet/foundation-core'

import {
  mechanicalStateFile,
  readStateFile,
  renderStateMarkdown,
  stateFileAsk,
  type StateFile,
} from '../src/index.ts'

const peerId = 'engineer-1' as PeerId
const valid: StateFile = {
  peerId,
  goal: 'ship the supervisor',
  done: ['peer-state mapping'],
  inFlight: ['purge protocol'],
  next: ['tests'],
  decisions: ['the state file is a file, not a parsed reply'],
  openQuestions: ['does the mailbox replay nudge or brief?'],
  briefVersion: 3,
}

test('a fenced json block is read as the state file', () => {
  const reply = `Here is my state.\n\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n\nThat is everything.`
  const reading = readStateFile(reply, peerId)
  assert.ok(reading.ok)
  assert.deepEqual(reading.stateFile, valid)
})

test('a bare object is accepted, an unlabelled fence too', () => {
  assert.deepEqual(readStateFile(JSON.stringify(valid), peerId), { ok: true, stateFile: valid })
  const bare = `\`\`\`\n${JSON.stringify(valid)}\n\`\`\``
  assert.deepEqual(readStateFile(bare, peerId), { ok: true, stateFile: valid })
})

test('the last block wins, because the peer’s final answer is the one that counts', () => {
  const reply = `\`\`\`json\n{"draft":true}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``
  assert.deepEqual(readStateFile(reply, peerId), { ok: true, stateFile: valid })
})

test('a reply with no state file says so, without inventing one', () => {
  const reading = readStateFile('I am still working on it, will report soon.', peerId)
  assert.equal(reading.ok, false)
  assert.match(reading.ok ? '' : reading.reason, /not valid JSON/)
})

test('a missing field is named, so the second ask can fix it', () => {
  const { next: _omitted, ...partial } = valid
  const reading = readStateFile(JSON.stringify(partial), peerId)
  assert.equal(reading.ok, false)
  assert.match(reading.ok ? '' : reading.reason, /next/)
})

test('an empty reply is refused before any parsing happens', () => {
  assert.deepEqual(readStateFile('   ', peerId), { ok: false, reason: 'the reply carried no state file' })
})

test('a state file naming another peer is refused: it would start the next session as someone else', () => {
  const reading = readStateFile(JSON.stringify({ ...valid, peerId: 'engineer-2' }), peerId)
  assert.equal(reading.ok, false)
  assert.match(reading.ok ? '' : reading.reason, /engineer-2, not engineer-1/)
})

test('the ask names every required field and the brief version it wants back', () => {
  const ask = stateFileAsk(7)
  for (const field of ['peerId', 'goal', 'done', 'inFlight', 'next', 'decisions', 'openQuestions', 'briefVersion']) {
    assert.match(ask, new RegExp(`"${field}"`), `${field} must be in the ask`)
  }
  assert.match(ask, /"briefVersion": 7/)
  assert.match(ask, /not a question about the work/)
})

test('the mechanical fallback carries facts and invents no intentions', () => {
  const state = mechanicalStateFile({
    peerId,
    briefVersion: 3,
    goal: 'ship the supervisor',
    assignedWork: ['work_1'],
    prs: ['#26'],
    branch: 'fleet-provider-deepinfra',
  })
  assert.deepEqual(state.inFlight, ['work_1', '#26'])
  assert.deepEqual(state.next, [], 'the fleet does not know what the peer meant to do next')
  assert.deepEqual(state.done, [])
  assert.equal(state.briefVersion, 3)
})

test('the mechanical fallback says when it knows nothing about the session', () => {
  const state = mechanicalStateFile({ peerId, briefVersion: 1, goal: 'g', assignedWork: [], prs: [] })
  assert.equal(state.openQuestions.length, 1)
})

test('the human copy is markdown derived from the typed object', () => {
  const markdown = renderStateMarkdown(valid, '2026-11-10T09:00:00.000Z')
  assert.match(markdown, /^# engineer-1\n/)
  assert.match(markdown, /Written 2026-11-10T09:00:00.000Z, from brief v3\./)
  assert.match(markdown, /## Next\n\n- tests/)
  const empty = renderStateMarkdown({ ...valid, done: [] }, '2026-11-10T09:00:00.000Z')
  assert.match(empty, /## Done\n\n_none_/)
})
