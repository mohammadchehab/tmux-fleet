/**
 * The words on the rows (§4), from one `ls` and nothing else.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rowsOf } from '../src/rows.ts'
import { activityOf, compactionsOf, decisionOf, lsOf, peerOf, tokensOf } from './fixtures.ts'

test('an open decision is a needs-you row; an answered one is gone', () => {
  const open = decisionOf('d-1', 'Ship the spike?', ['Ship', 'Hold'])
  const answered = { ...decisionOf('d-2'), state: 'answered' as const, option: 'Yes' }
  const rows = rowsOf(lsOf({ decisions: [open, answered] }))

  assert.equal(rows.needsYou.length, 1)
  const row = rows.needsYou[0]
  assert.ok(row !== undefined)
  assert.equal(row.kind, 'decision')
  assert.equal(row.id, 'decision:d-1')
  assert.equal(row.label, 'Ship the spike?')
  assert.equal(row.description, 'approval')
  assert.match(row.tooltip, /· Ship/)
})

test('a peer waiting for input is a needs-you row that names it', () => {
  const rows = rowsOf(lsOf({ peers: [peerOf('engineer-1', 'waiting_input')] }))

  assert.deepEqual(
    rows.needsYou.map((row) => [row.kind, row.id, row.label]),
    [['input', 'input:engineer-1', 'engineer-1 is waiting for input']],
  )
  assert.equal(rows.needsYou[0]?.peerId, 'engineer-1')
})

test('peers are ordered by id, so a row keeps its place between polls', () => {
  const rows = rowsOf(lsOf({ peers: [peerOf('peer-b'), peerOf('peer-c'), peerOf('peer-a')] }))
  assert.deepEqual(
    rows.peers.map((row) => row.peerId),
    ['peer-a', 'peer-b', 'peer-c'],
  )
})

test('a row says what the peer is doing and how many turns it has run', () => {
  const rows = rowsOf(
    lsOf({
      peers: [peerOf('engineer-1', 'working')],
      activity: [activityOf('engineer-1', 'Read', 'src/mailbox.ts')],
      tokens: [tokensOf('engineer-1', 3)],
    }),
  )
  assert.equal(rows.peers[0]?.description, 'Read src/mailbox.ts · 3 turns')
})

test('a peer with no activity says its state instead of inventing one', () => {
  const rows = rowsOf(lsOf({ peers: [peerOf('engineer-1', 'waiting_input')] }))
  assert.equal(rows.peers[0]?.description, 'waiting for you')
})

test('the rollup row is the peer, and works are only summed when there is no rollup', () => {
  const rollup = tokensOf('engineer-1', 10)
  const oneWork = { ...tokensOf('engineer-1', 2), workId: 'TASK-1' as never }
  const twoWork = { ...tokensOf('engineer-1', 3), workId: 'TASK-2' as never }

  const withRollup = rowsOf(lsOf({ peers: [peerOf('engineer-1')], tokens: [rollup, oneWork, twoWork] }))
  assert.equal(withRollup.peers[0]?.description, 'idle · 10 turns')

  const summed = rowsOf(lsOf({ peers: [peerOf('engineer-1')], tokens: [oneWork, twoWork] }))
  assert.equal(summed.peers[0]?.description, 'idle · 5 turns')
})

test('a peer that has compacted is marked, and its tooltip says how often', () => {
  const rows = rowsOf(lsOf({ peers: [peerOf('engineer-1')], compactions: [compactionsOf('engineer-1', 3)] }))
  assert.equal(rows.peers[0]?.warning, true)
  assert.match(rows.peers[0]?.tooltip ?? '', /compacted 3 times/)
})

test('a peer that has not compacted is not marked', () => {
  const rows = rowsOf(lsOf({ peers: [peerOf('engineer-1')], compactions: [compactionsOf('engineer-1', 0)] }))
  assert.equal(rows.peers[0]?.warning, false)
  assert.doesNotMatch(rows.peers[0]?.tooltip ?? '', /compacted/)
})

test('the actions a row offers follow its standing, not its exact state', () => {
  const rows = rowsOf(lsOf({ peers: [peerOf('busy', 'working'), peerOf('gone', 'ended')] }))
  const busy = rows.peers.find((row) => row.peerId === 'busy')
  const gone = rows.peers.find((row) => row.peerId === 'gone')
  assert.deepEqual(busy?.actions, ['takeover', 'takeover-now', 'send', 'stop'])
  assert.deepEqual(gone?.actions, ['start'])
})

test('the tooltip carries the tokens and cost the row has no room for', () => {
  const rows = rowsOf(lsOf({ peers: [peerOf('engineer-1')], tokens: [{ ...tokensOf('engineer-1', 2), costUsd: 1.5 }] }))
  const tooltip = rows.peers[0]?.tooltip ?? ''
  assert.match(tooltip, /state: idle/)
  assert.match(tooltip, /turns: 2/)
  assert.match(tooltip, /tokens: 2000 in \/ 200 out/)
  assert.match(tooltip, /cost: \$1\.50/)
})
