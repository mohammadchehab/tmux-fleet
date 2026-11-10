/**
 * The grid, as data: which session, and the tmux argv that builds it. No tmux is
 * run, which is the point — a person debugging "why did the view open wrong" can
 * read the plan instead of watching a terminal.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCommands, hasSessionCommand, paneCommand, showCommand, viewSessionName, WINDOW } from '../src/tmux.ts'

const options = {
  command: ['/usr/bin/node', '/repo/apps/clients/view/src/main.ts'],
  socketPath: '/home/someone/.fleet/firstrun/daemon/fleetd.sock',
  intervalMs: 2_000,
  session: 'fleet-firstrun',
}

describe('tmux: one pane per peer', () => {
  it('quotes the command as one shell word per argument, because tmux joins and shells it', () => {
    assert.equal(
      paneCommand(options, 'engineer-1'),
      "'/usr/bin/node' '/repo/apps/clients/view/src/main.ts' '--socket' '/home/someone/.fleet/firstrun/daemon/fleetd.sock' '--pane' 'engineer-1' '--interval' '2000'",
    )
  })

  it('survives a socket path with a quote or a space in it', () => {
    const command = paneCommand({ ...options, socketPath: "/tmp/it's a dir/fleetd.sock" }, 'engineer-1')
    // The whole thing is one tmux argument; the shell must see the path intact.
    assert.match(command, /'\/tmp\/it'\\''s a dir\/fleetd\.sock'/)
  })

  it('starts one session, splits the rest, tiles them, and titles every pane', () => {
    const commands = buildCommands({ ...options, peers: ['engineer-1', 'engineer-2', 'engineer-3'] })
    const kinds = commands.map((argv) => argv[0])
    assert.deepEqual(kinds, [
      'new-session',
      'set-option',
      'split-window',
      'split-window',
      'select-layout',
      'set-window-option',
      'select-pane',
      'select-pane',
      'select-pane',
    ])

    const first = commands[0] ?? []
    assert.deepEqual(first.slice(1, 7), ['-d', '-s', 'fleet-firstrun', '-n', WINDOW, '-x'])
    // The pane's command is the last element and arrives as one quoted string.
    const command = first.at(-1) ?? ''
    assert.match(command, /'--pane' 'engineer-1'/)
    assert.ok(!command.includes('engineer-2'), 'the second peer is a split, not part of the first pane`s command')

    const target = `fleet-firstrun:${WINDOW}`
    assert.deepEqual(commands[2]?.slice(0, 3), ['split-window', '-t', target])
    assert.deepEqual(commands[4], ['select-layout', '-t', target, 'tiled'])
    assert.deepEqual(commands[6], ['select-pane', '-t', `${target}.0`, '-T', 'engineer-1'])
    assert.deepEqual(commands[8], ['select-pane', '-t', `${target}.2`, '-T', 'engineer-3'])
  })

  it('does not split for a fleet of one', () => {
    const kinds = buildCommands({ ...options, peers: ['engineer-1'] }).map((argv) => argv[0])
    assert.ok(!kinds.includes('split-window'))
    assert.ok(!kinds.includes('select-layout'), 'a single pane has no layout to choose')
  })

  it('plans nothing for a fleet with no peers, rather than an empty session', () => {
    assert.deepEqual(buildCommands({ ...options, peers: [] }), [])
  })

  it('leaves a dead pane on screen instead of re-tiling the grid around it', () => {
    const commands = buildCommands({ ...options, peers: ['engineer-1', 'engineer-2'] })
    const remain = commands.find((argv) => argv[0] === 'set-window-option')
    assert.deepEqual(remain, ['set-window-option', '-t', `fleet-firstrun:${WINDOW}`, 'remain-on-exit', 'on'])
  })
})

describe('tmux: which session', () => {
  it('is named after the profile, so two fleets are two views', () => {
    assert.equal(viewSessionName('firstrun'), 'fleet-firstrun')
    assert.equal(viewSessionName(undefined), 'fleet-view')
  })

  it('attaches outside tmux and switches inside it', () => {
    assert.deepEqual(showCommand('fleet-firstrun', false), ['attach-session', '-t', 'fleet-firstrun'])
    assert.deepEqual(showCommand('fleet-firstrun', true), ['switch-client', '-t', 'fleet-firstrun'])
    assert.deepEqual(hasSessionCommand('fleet-firstrun'), ['has-session', '-t', 'fleet-firstrun'])
  })
})
