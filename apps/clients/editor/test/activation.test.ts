/**
 * The extension end to end, minus the editor: activate, poll, click.
 *
 * These are the tests that replace a UI test suite (§12): the person's
 * affordances — a row's click, a menu item, a queued quick pick — go in one side,
 * and what the daemon was asked and what the editor was told to run come out the
 * other.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { activateWith, type Activation } from '../src/activation.ts'
import type { FleetDaemon } from '../src/daemon.ts'
import type { OpenWatch } from '../src/output.ts'
import type { WatchFrame } from '@fleet/foundation-contracts'
import { lsOf, decisionOf, compactionsOf, peerOf } from './fixtures.ts'
import { fakeEditor, type FakeEditor } from './fake-editor.ts'

interface Calls {
  readonly decide: unknown[]
  readonly send: unknown[]
  listCount: number
}

interface Harness {
  readonly editor: FakeEditor
  readonly activation: Activation
  readonly calls: Calls
  /** Replaces the daemon's answer for the next poll. */
  answer(ls: ReturnType<typeof lsOf>): void
  /** Makes the next poll fail, as a daemon that went away would. */
  fail(reason: string): void
  /** Every `peer.watch` the window opened, with a way to push frames down it and to end it. */
  readonly watches: { readonly since?: number; push(frame: WatchFrame): void; end(): void; closed: boolean }[]
}

const harness = (options: {
  settings?: Record<string, unknown>
  ls?: ReturnType<typeof lsOf>
  failWith?: string
  env?: Record<string, string | undefined>
} = {}): Harness => {
  const editor = fakeEditor({
    home: '/nonexistent-tester-home',
    settings: { profile: 'tmux-fleet', ...options.settings },
    ...(options.env === undefined ? {} : { env: options.env }),
  })

  const calls: Calls = { decide: [], send: [], listCount: 0 }
  let ls = options.ls ?? lsOf()
  let failure = options.failWith

  const daemon: FleetDaemon = {
    ls: async () => {
      calls.listCount += 1
      if (failure !== undefined) throw new Error(failure)
      return ls
    },
    decide: async (params) => {
      calls.decide.push(params)
      return {}
    },
    send: async (params) => {
      calls.send.push(params)
      return {}
    },
  }

  const watches: Harness['watches'] = []
  const openWatch: OpenWatch = ({ since, onFrame, onClose }) => {
    const watch = {
      ...(since === undefined ? {} : { since }),
      closed: false,
      push: (frame: WatchFrame) => onFrame(frame),
      end: () => onClose(),
    }
    watches.push(watch)
    return {
      close: () => {
        watch.closed = true
        onClose()
      },
    }
  }

  const activation = activateWith({ editor, daemonFor: () => daemon, openWatch })
  return {
    editor,
    activation,
    calls,
    watches,
    answer: (next) => {
      ls = next
    },
    fail: (reason) => {
      failure = reason
    },
  }
}

const rows = (harness: Harness) => harness.editor.provider?.children(undefined) ?? []

test('a fleet that stopped answering says so and keeps the rows it last knew', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1')] }) })
  await h.activation.tick()

  h.fail('ENOENT: no such file or directory')
  await h.activation.tick()

  const [notice, , peers] = rows(h)
  assert.equal(notice?.label, 'Disconnected')
  assert.match(notice?.description ?? '', /ENOENT/)
  assert.equal(h.editor.status, 'Fleet: disconnected')
  // The peer is still drawn: an empty tree and a lost daemon must not look alike.
  assert.equal(peers === undefined ? 0 : h.editor.provider?.children(peers).length, 1)
})

test('a fleet that has never been named and is not running is a Start button', async () => {
  const h = harness({ settings: { profile: undefined } })
  // No profile, no socket, no env, no running profile on disk.
  await h.activation.tick()

  const [notice] = rows(h)
  assert.equal(notice?.label, 'No fleet is running')
  assert.equal(notice?.commandId, 'fleet.start')
  assert.equal(h.editor.status, 'Fleet: not running')
  assert.equal(h.editor.badge, 0)
})

test('the start command opens a terminal on `fleet up`', async () => {
  const h = harness({ settings: { profile: undefined } })
  await h.activation.tick()
  await h.editor.click('fleet.start')

  assert.deepEqual(h.editor.terminals, [{ name: 'fleet: up', argv: ['fleet', 'up'] }])
})

test('a connected fleet draws two sections and says the count in the status bar', async () => {
  const h = harness({
    ls: lsOf({ peers: [peerOf('engineer-1', 'working'), peerOf('engineer-2', 'idle')], decisions: [decisionOf('d-1')] }),
  })
  await h.activation.tick()

  const [needsYou, peers] = rows(h)
  assert.equal(needsYou?.label, 'Needs you (1)')
  assert.equal(peers?.label, 'Peers')
  assert.equal(h.editor.badge, 1)
  assert.equal(h.editor.status, 'Fleet: 2 peers · 1 need you')
})

test('a poll that moves one peer refreshes that row and does not redraw the tree', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1'), peerOf('engineer-2')] }) })
  await h.activation.tick()
  h.editor.refreshes.length = 0

  const peerSection = rows(h)[1]
  const before = peerSection === undefined ? [] : (h.editor.provider?.children(peerSection) ?? [])

  h.answer(lsOf({ peers: [peerOf('engineer-1', 'working'), peerOf('engineer-2')] }))
  await h.activation.tick()

  assert.equal(h.editor.refreshes.length >= 1, true)
  // Never `undefined`: a full-tree refresh is what §4 exists to avoid.
  assert.ok(
    h.editor.refreshes.every((item) => item !== undefined),
    'a poll with no shape change must not redraw the whole tree',
  )
  const after = h.editor.provider?.children(peerSection) ?? []
  assert.equal(after[0], before[0], 'the row object is reused, so the refresh reaches the right item')
})

test('answering a decision sends exactly one decide, with the option that was picked', async () => {
  const h = harness({ ls: lsOf({ decisions: [decisionOf('d-1', 'Ship it?', ['Ship', 'Hold'])] }) })
  await h.activation.tick()

  h.editor.picks.push('Hold')
  await h.editor.click('fleet.decision.answer', 'd-1')

  assert.deepEqual(h.calls.decide, [{ id: 'd-1', decision: 'Hold' }])
  assert.match(h.editor.notifications.at(-1)?.message ?? '', /Answered d-1: Hold/)
})

test('dismissing the quick pick answers nothing', async () => {
  const h = harness({ ls: lsOf({ decisions: [decisionOf('d-1')] }) })
  await h.activation.tick()

  h.editor.picks.push(undefined)
  await h.editor.click('fleet.decision.answer', 'd-1')

  assert.deepEqual(h.calls.decide, [])
})

test('a decision that was answered elsewhere is re-read, not invented', async () => {
  const h = harness({ ls: lsOf({ decisions: [decisionOf('d-1')] }) })
  h.answer(lsOf({}))
  await h.activation.tick()

  h.editor.picks.push('Yes')
  await h.editor.click('fleet.decision.answer', 'd-1')

  assert.deepEqual(h.calls.decide, [])
  assert.match(h.editor.notifications.at(-1)?.message ?? '', /no longer open/)
})

test('a takeover is an integrated terminal named for the peer, running fleet attach', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1', 'working')] }) })
  await h.activation.tick()

  h.editor.picks.push('takeover')
  await h.editor.click('fleet.peer.actions', 'engineer-1')

  assert.deepEqual(h.editor.terminals, [{ name: 'fleet: engineer-1', argv: ['fleet', 'attach', 'engineer-1'] }])
  assert.deepEqual(h.editor.runs, [], 'a takeover is not a one-shot: it is a terminal the person closes')
})

test('the takeover menu item skips the quick pick and runs the same command', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1', 'working')] }) })
  await h.activation.tick()

  await h.editor.click('fleet.peer.takeover.now', 'engineer-1')

  assert.deepEqual(h.editor.terminals, [
    { name: 'fleet: engineer-1', argv: ['fleet', 'attach', 'engineer-1', '--now'] },
  ])
})

test('stop asks before it runs, and does nothing when told no', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1', 'working')] }) })
  await h.activation.tick()

  h.editor.confirms.push(false)
  await h.editor.click('fleet.peer.stop', 'engineer-1')
  assert.deepEqual(h.editor.runs, [])

  h.editor.confirms.push(true)
  await h.editor.click('fleet.peer.stop', 'engineer-1')
  assert.deepEqual(h.editor.runs, [['fleet', 'stop', 'engineer-1']])
})

test('start runs without asking, because starting nothing loses nothing', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1', 'ended')] }) })
  await h.activation.tick()

  await h.editor.click('fleet.peer.start', 'engineer-1')
  assert.deepEqual(h.editor.runs, [['fleet', 'start', 'engineer-1']])
  assert.deepEqual(h.editor.confirms, [])
})

test('a message becomes one send to that peer', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1')] }) })
  await h.activation.tick()

  h.editor.asks.push('look at TASK-4')
  await h.editor.click('fleet.peer.send', 'engineer-1')

  assert.deepEqual(h.calls.send, [{ to: 'engineer-1', kind: 'nudge', body: 'look at TASK-4' }])
})

test('an empty message is not sent', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1')] }) })
  await h.activation.tick()

  h.editor.asks.push('   ')
  await h.editor.click('fleet.peer.send', 'engineer-1')
  assert.deepEqual(h.calls.send, [])
})

test('the configured command is what the actions run', async () => {
  const h = harness({ settings: { command: 'node apps/clients/cli/src/main.ts' }, ls: lsOf({ peers: [peerOf('p', 'working')] }) })
  await h.activation.tick()
  await h.editor.click('fleet.peer.takeover', 'p')

  assert.deepEqual(h.editor.terminals[0]?.argv, ['node apps/clients/cli/src/main.ts', 'attach', 'p'])
})

test('an action on a disconnected window says so instead of running', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('p', 'working')] }) })
  await h.activation.tick()
  h.fail('ENOENT')
  await h.activation.tick()

  await h.editor.click('fleet.peer.stop', 'p')

  assert.deepEqual(h.editor.runs, [])
  assert.equal(h.editor.notifications.at(-1)?.severity, 'warning')
})

test('choosing a profile remembers it, then looks again', async () => {
  const h = harness({ settings: { profile: undefined } })
  await h.activation.tick()

  await h.editor.changeSetting('profile', 'tmux-fleet')
  assert.equal(h.editor.settings['profile'], 'tmux-fleet')
})

test('a compaction warning reaches the row the person sees', async () => {
  const h = harness({
    ls: lsOf({ peers: [peerOf('engineer-1')], compactions: [compactionsOf('engineer-1', 2)] }),
  })
  await h.activation.tick()

  const peers = rows(h)[1]
  const [row] = peers === undefined ? [] : (h.editor.provider?.children(peers) ?? [])
  assert.equal(row?.warning, true)
})

test('every command the manifest offers is registered, and nothing else is', async () => {
  const h = harness()
  await h.activation.tick()

  assert.deepEqual(h.editor.commandIds.slice().sort(), [
    'fleet.choose-profile',
    'fleet.decision.answer',
    'fleet.focus',
    'fleet.peer.actions',
    'fleet.peer.output',
    'fleet.peer.send',
    'fleet.peer.start',
    'fleet.peer.stop',
    'fleet.peer.takeover',
    'fleet.peer.takeover.now',
    'fleet.refresh',
    'fleet.start',
  ])
})

test('the setting that names the program is machine-scoped, so a repository cannot set it', async () => {
  // `fleet.command` reaches `execFile` and a terminal. A workspace setting arrives
  // with the cloned repository, which would make "open a folder" into "run this
  // program". The manifest is what the editor enforces; `vscode-port` reads the
  // user value directly as well, and the two must agree.
  const manifest = JSON.parse(
    await readFile(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8'),
  ) as { readonly contributes: { readonly configuration: { readonly properties: Record<string, { readonly scope?: string }> } } }
  const properties = manifest.contributes.configuration.properties
  assert.equal(properties['fleet.command']?.scope, 'machine')
})

const at = '2026-11-12T12:00:00.000Z'
const lineFrame = (seq: number, peerId: string, text: string): WatchFrame =>
  ({ stream: 'line', seq, at, peerId, line: { kind: 'text', text } }) as WatchFrame

test('clicking a peer opens its live output, fed from one watch stream', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1', 'working'), peerOf('engineer-2', 'working')] }) })
  await h.activation.tick()

  const peers = rows(h)[1]
  const [row] = peers === undefined ? [] : (h.editor.provider?.children(peers) ?? [])
  assert.equal(row?.commandId, 'fleet.peer.output', 'the click is the output, the actions are the menu')

  // Lines for a peer nobody has opened yet are kept, so opening it shows them.
  await h.editor.click('fleet.peer.output', 'engineer-1')
  assert.equal(h.watches.length, 1)
  h.watches[0]?.push(lineFrame(1, 'engineer-1', 'reading the brief'))
  h.watches[0]?.push(lineFrame(2, 'engineer-2', 'running the tests'))
  h.watches[0]?.push({
    stream: 'row',
    seq: 3,
    at,
    row: { kind: 'mail', phase: 'sent', msgId: 'msg_0123456789abcdef', to: 'engineer-1', from: 'pm', mailKind: 'brief', text: 'Brief v2\nWork: fix it' },
  } as WatchFrame)
  h.watches[0]?.push({ stream: 'line', seq: 4, at, peerId: 'engineer-1', line: { kind: 'tool', tool: 'Bash', summary: 'pnpm test' } } as WatchFrame)

  const one = h.editor.outputs.get('Fleet: engineer-1')
  assert.deepEqual(one?.lines, ['reading the brief', '✉ brief from pm', '  Brief v2', '  Work: fix it', '⚙ Bash pnpm test'])
  assert.equal(one?.shown, 1)

  await h.editor.click('fleet.peer.output', 'engineer-2')
  assert.equal(h.watches.length, 1, 'a second channel shares the stream')
  assert.deepEqual(h.editor.outputs.get('Fleet: engineer-2')?.lines, ['running the tests'])

  h.activation.dispose()
  assert.equal(h.watches[0]?.closed, true)
  assert.equal(one?.disposed, true)
})

test('a stream the daemon dropped reconnects from the last seq it saw', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1', 'working')] }) })
  await h.activation.tick()
  await h.editor.click('fleet.peer.output', 'engineer-1')
  h.watches[0]?.push(lineFrame(7, 'engineer-1', 'before'))
  h.watches[0]?.end()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 3_100)
  })
  assert.equal(h.watches.length, 2)
  assert.equal(h.watches[1]?.since, 7)
  h.activation.dispose()
})

test('a context-menu item, which hands over the whole row, acts on that row\'s peer', async () => {
  const h = harness({ ls: lsOf({ peers: [peerOf('engineer-1', 'working')] }) })
  await h.activation.tick()
  const peers = rows(h)[1]
  const [row] = peers === undefined ? [] : (h.editor.provider?.children(peers) ?? [])

  h.editor.asks.push('look at TASK-4')
  await h.editor.click('fleet.peer.send', row)
  assert.deepEqual(h.calls.send, [{ to: 'engineer-1', kind: 'nudge', body: 'look at TASK-4' }])
})
