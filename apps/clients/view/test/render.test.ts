/**
 * What a pane and a table put on screen. Pure: one `ls` answer in, lines out, no
 * socket and no terminal, so the layout is a character-level assertion rather
 * than a screenshot nobody reads.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderPaneFailure, renderPeer, renderTable, renderUnknownPeer } from '../src/render.ts'
import { SESSION, lsFixture, peerFixture } from './fixtures.ts'

describe('render: a peer pane', () => {
  it('leads with the identity and the state, then one labelled field per line', () => {
    const lines = renderPeer(peerFixture({ peerId: 'engineer-1', currentSessionId: SESSION, worktreeId: undefined }))
    assert.deepEqual(lines, [
      'engineer-1  working',
      '  role      engineer',
      '  provider  claude/opus',
      `  session   ${SESSION}`,
      '  brief     v3',
      '  worktree  none',
      '  updated   2026-11-10 12:59:55',
    ])
  })

  it('prints a peer with no session as `none`, not as an empty field', () => {
    const lines = renderPeer(peerFixture({ peerId: 'engineer-2', currentSessionId: undefined, state: 'ended' }))
    assert.equal(lines[0], 'engineer-2  ended')
    assert.equal(
      lines.find((line) => line.trimStart().startsWith('session')),
      '  session   none',
    )
  })

  it('spells the state the way the projection does', () => {
    for (const state of ['starting', 'working', 'waiting_input', 'idle', 'ended', 'failed'] as const) {
      const [first] = renderPeer(peerFixture({ peerId: 'engineer-1', state }))
      assert.equal(first, `engineer-1  ${state}`)
    }
  })

  it('keeps a peer id it cannot place rather than an empty pane', () => {
    assert.deepEqual(renderUnknownPeer('engineer-9'), [
      'engineer-9',
      '  unknown   no peer by that id in this fleet',
    ])
  })

  it('names the peer and the reason when the daemon could not be read', () => {
    assert.deepEqual(renderPaneFailure('engineer-1', 'cannot reach fleetd at /x: ENOENT'), [
      'engineer-1',
      '  cannot    cannot reach fleetd at /x: ENOENT',
    ])
  })
})

describe('render: the whole fleet', () => {
  it('prints the status, then a header and one row per peer, aligned', () => {
    const text = renderTable(
      lsFixture([
        peerFixture({ peerId: 'engineer-1', currentSessionId: SESSION, state: 'working' }),
        peerFixture({ peerId: 'engineer-22', role: 'reviewer', providerId: 'deepinfra', model: 'kimi', state: 'idle' }),
      ]),
    )
    const lines = text.split('\n')
    assert.equal(lines[0], 'firstrun  pid 4242  up since 2026-11-10 08:00:00')
    assert.equal(lines[1], 'socket  /home/someone/.fleet/firstrun/daemon/fleetd.sock')
    assert.equal(lines[3], 'peers (2)')

    const cells = (line: string | undefined): readonly string[] =>
      (line ?? '').trim().split(/\s{2,}/).filter((cell) => cell !== '')
    assert.deepEqual(cells(lines[4]), ['PEER', 'STATE', 'ROLE', 'PROVIDER/MODEL', 'BRIEF', 'SESSION'])
    assert.deepEqual(cells(lines[5]), ['engineer-1', 'working', 'engineer', 'claude/opus', 'v3', SESSION])
    assert.deepEqual(cells(lines[6]), ['engineer-22', 'idle', 'reviewer', 'deepinfra/kimi', 'v3', '-'])

    // Widths differ per row, so alignment is the claim worth asserting: the state
    // column starts at the same offset on the header and on every peer row.
    const stateAt = (lines[4] ?? '').indexOf('STATE')
    assert.ok(stateAt > 0)
    assert.equal((lines[5] ?? '').indexOf('working'), stateAt)
    assert.equal((lines[6] ?? '').indexOf('idle'), stateAt)
  })

  it('says so instead of printing a header over nothing', () => {
    const text = renderTable(lsFixture([]))
    assert.match(text, /^peers \(0\)\n {2}none registered$/m)
  })

  it('never leaves trailing spaces on a line', () => {
    const text = renderTable(lsFixture([peerFixture({ peerId: 'engineer-1', currentSessionId: SESSION })]))
    for (const line of text.split('\n')) assert.equal(line, line.trimEnd())
  })
})
