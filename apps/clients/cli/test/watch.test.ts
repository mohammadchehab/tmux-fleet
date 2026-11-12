/**
 * `fleet watch` (watch-and-attach §7): keys, the needs-you strip, the model's
 * reducer, the render, `--once`, and the terminal loop — all without a terminal.
 */

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import type { DaemonMethod, Decision, LsResult, Peer, PeerActivity, WatchFrame } from '@fleet/foundation-contracts'
import type { DecisionId, PeerId } from '@fleet/foundation-core'

import type { DaemonCaller } from '../src/client.ts'
import { run } from '../src/run.ts'
import { runWatch } from '../src/watch/interactive.ts'
import { createKeyParser, type Key } from '../src/watch/keys.ts'
import { initialState, peerMenu, reduce, selectables, type Input, type WatchState } from '../src/watch/model.ts'
import { needsYou } from '../src/watch/needs.ts'
import { detailLines, render, renderOnce } from '../src/watch/render.ts'
import type { OpenWatch } from '../src/watch/stream.ts'
import { fit, wrap } from '../src/watch/text.ts'

const peer = (id: string, overrides: Partial<Peer> = {}): Peer => ({
  peerId: id as PeerId,
  role: 'engineer',
  providerId: 'claude',
  model: 'opus',
  permissionMode: 'acceptEdits',
  briefVersion: 1,
  state: 'idle',
  registeredAt: '2026-11-10T09:00:00.000Z',
  updatedAt: '2026-11-10T12:00:00.000Z',
  ...overrides,
})

const decision = (id: string, at: string, options: readonly string[] = ['merge', 'hold']): Decision => ({
  decisionId: `dec_${id.padEnd(16, '0')}` as DecisionId,
  kind: 'judge',
  state: 'open',
  question: `ship ${id}?`,
  options,
  inputsHash: 'abcdef0123456789',
  requestedAt: at,
})

const ls = (peers: readonly Peer[], decisions: readonly Decision[] = [], activity: readonly PeerActivity[] = []): LsResult => ({
  status: {
    profile: 'squad',
    pid: 1,
    startedAt: '2026-11-10T08:00:00.000Z',
    socketPath: '/s',
    storePath: '/db',
    protocolVersion: 2,
    purgeContextRatio: 0.6,
  },
  peers,
  routines: [],
  decisions,
  compactions: [],
  tokens: [],
  activity,
})

const keys = (...chunks: string[]): readonly Key[] => {
  const parser = createKeyParser()
  return [...chunks.flatMap((chunk) => parser.feed(chunk)), ...parser.flush()]
}

const strip = (line: string): string => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')

const feed = (state: WatchState, ...inputs: Input[]): { state: WatchState; effects: unknown[] } => {
  let current = state
  const effects: unknown[] = []
  for (const input of inputs) {
    const step = reduce(current, input)
    current = step.state
    effects.push(...step.effects)
  }
  return { state: current, effects }
}

const key = (k: Key): Input => ({ type: 'key', key: k })
const char = (c: string): Input => key({ kind: 'char', char: c })

describe('key parser', () => {
  it('reads arrows, enter, and characters, however the chunks fall', () => {
    assert.deepEqual(keys('\u001b[A', '\u001b[B\r', 'q').map((k) => k.kind), ['up', 'down', 'enter', 'char'])
    assert.deepEqual(keys('\u001b', '[A').map((k) => k.kind), ['up'])
    assert.deepEqual(keys('\u001bOB').map((k) => k.kind), ['down'])
  })

  it('holds a lone escape until flushed, then reports the escape key', () => {
    const parser = createKeyParser()
    assert.deepEqual(parser.feed('\u001b'), [])
    assert.equal(parser.pending, true)
    assert.deepEqual(parser.flush(), [{ kind: 'escape' }])
    assert.equal(parser.pending, false)
  })

  it('reads a multi-byte character split across chunks as one key', () => {
    const bytes = Buffer.from('é')
    const parser = createKeyParser()
    assert.deepEqual(parser.feed(bytes.subarray(0, 1)), [])
    assert.deepEqual(parser.feed(bytes.subarray(1)), [{ kind: 'char', char: 'é' }])
  })

  it('reads ctrl-c, backspace and tab', () => {
    assert.deepEqual(keys('\u0003\u007f\t').map((k) => k.kind), ['ctrl-c', 'backspace', 'tab'])
  })
})

describe('needs you', () => {
  it('lists open decisions and waiting peers, oldest first, and nothing else', () => {
    const answered: Decision = { ...decision('done', '2026-11-10T07:00:00.000Z'), state: 'answered' }
    const needs = needsYou(
      ls(
        [peer('a', { state: 'waiting_input', updatedAt: '2026-11-10T10:00:00.000Z' }), peer('b', { state: 'working' })],
        [decision('late', '2026-11-10T11:00:00.000Z'), decision('early', '2026-11-10T09:00:00.000Z'), answered],
      ),
    )
    assert.deepEqual(
      needs.map((need) => (need.kind === 'decision' ? need.decision.question : need.peer.peerId)),
      ['ship early?', 'a', 'ship late?'],
    )
  })

  it('is empty when nothing waits', () => {
    assert.deepEqual(needsYou(ls([peer('a')])), [])
  })
})

describe('text', () => {
  it('fits to an exact width', () => {
    assert.equal(fit('abc', 5), 'abc  ')
    assert.equal(fit('abcdef', 4), 'abc…')
    assert.equal(fit('x', 0), '')
  })
  it('wraps at spaces and keeps blank lines', () => {
    assert.deepEqual(wrap('hello brave world', 11), ['hello brave', 'world'])
    assert.deepEqual(wrap('a\n\nb', 5), ['a', '', 'b'])
  })
  it('fits and wraps away terminal control characters rather than passing them on', () => {
    // A width is columns on the screen, so a control character that is not a
    // column must not be counted as one either.
    assert.equal(fit('a\u001b[2Jb', 2), 'ab')
    assert.deepEqual(wrap('a\u001b]0;x\u0007b c', 3), ['ab', 'c'])
    // A tab is a column, but not a width this can measure: it becomes a space.
    assert.equal(fit('a\tb', 3), 'a b')
  })
})

describe('the model', () => {
  const start = (state: WatchState, snapshot: LsResult): WatchState => feed(state, { type: 'snapshot', ls: snapshot }).state
  const base = initialState({ cols: 100, rows: 30 })

  it('moves the selection over needs then peers, and stays in range', () => {
    const state = start(base, ls([peer('a'), peer('b')], [decision('x', '2026-11-10T09:00:00.000Z')]))
    assert.equal(selectables(state).length, 3)
    const down = feed(state, char('j'), char('j'), char('j'), char('j')).state
    assert.equal(down.selected, 2)
    const up = feed(down, key({ kind: 'up' }), key({ kind: 'up' }), key({ kind: 'up' })).state
    assert.equal(up.selected, 0)
  })

  it('keeps the selection on the same row when a decision above it is answered', () => {
    const before = start(base, ls([peer('a'), peer('b')], [decision('x', '2026-11-10T09:00:00.000Z')]))
    const onB = feed(before, char('j'), char('j')).state
    assert.equal(selectables(onB)[onB.selected]?.kind, 'peer')
    const after = start(onB, ls([peer('a'), peer('b')]))
    const row = selectables(after)[after.selected]
    assert.equal(row?.kind === 'peer' ? row.peer.peerId : undefined, 'b')
  })

  it('opens a menu by the peer state, and the first item is taking over', () => {
    assert.match(peerMenu(peer('a', { state: 'working' })).items[0]?.label ?? '', /Take over when this turn ends/)
    assert.deepEqual(peerMenu(peer('a', { state: 'held' })).items.map((i) => i.action.kind), ['attach', 'release'])
    assert.deepEqual(peerMenu(peer('a', { state: 'stopped' })).items.map((i) => i.action.kind), ['start'])
  })

  it('turns enter on a menu item into one daemon action, and escape backs out', () => {
    const state = start(base, ls([peer('a', { state: 'working' })]))
    const opened = feed(state, key({ kind: 'enter' })).state
    assert.ok(opened.menu)
    assert.equal(feed(opened, key({ kind: 'escape' })).state.menu, undefined)
    const chosen = feed(opened, key({ kind: 'down' }), key({ kind: 'enter' }))
    assert.deepEqual(chosen.effects, [{ kind: 'run', action: { kind: 'attach', peer: 'a', now: true } }])
    assert.equal(chosen.state.menu, undefined)
  })

  it('answers a decision from its options', () => {
    const d = decision('x', '2026-11-10T09:00:00.000Z')
    const state = start(base, ls([peer('a')], [d]))
    const result = feed(state, key({ kind: 'enter' }), key({ kind: 'down' }), key({ kind: 'enter' }))
    assert.deepEqual(result.effects, [{ kind: 'run', action: { kind: 'decide', id: d.decisionId, option: 'hold' } }])
  })

  it('composes a message and sends it, and drops an empty one', () => {
    const state = start(base, ls([peer('a', { state: 'idle' })]))
    const composing = feed(state, key({ kind: 'enter' }), ...[0, 1, 2, 3].map(() => key({ kind: 'down' })).slice(0, 3), key({ kind: 'enter' })).state
    assert.deepEqual(composing.compose, { to: { kind: 'peer', peer: 'a' }, text: '' })
    const typed = feed(composing, char('h'), char('i'), char('x'), key({ kind: 'backspace' }), key({ kind: 'enter' }))
    assert.deepEqual(typed.effects, [{ kind: 'send', peer: 'a', body: 'hi' }])
    assert.equal(typed.state.compose, undefined)
    assert.deepEqual(feed(composing, key({ kind: 'enter' })).effects, [])
  })

  it('collects lines and mail per peer, bounded, and asks for a refresh on a state row', () => {
    let state = start(base, ls([peer('a')]))
    const frame = (f: WatchFrame): Input => ({ type: 'frame', frame: f })
    const result = feed(
      state,
      frame({ stream: 'line', seq: 1, at: 't', peerId: 'a' as PeerId, line: { kind: 'text', text: 'hello' } }),
      frame({ stream: 'row', seq: 2, at: 't', row: { kind: 'state', peerId: 'a' as PeerId, state: 'working' } }),
      frame({ stream: 'ready', seq: 2, from: 1, protocolVersion: 2 }),
    )
    state = result.state
    assert.equal(state.timelines.get('a' as PeerId)?.length, 1)
    assert.equal(state.lastSeq, 2)
    assert.equal(state.link, 'live')
    assert.deepEqual(result.effects, [{ kind: 'refresh' }, { kind: 'refresh' }])
    assert.equal(feed(state, frame({ stream: 'end', reason: 'dropped' })).state.link, 'lost')
  })

  it('answers a decision with no options in free text', () => {
    const d = decision('free', '2026-11-10T09:00:00.000Z', [])
    const state = start(base, ls([peer('a')], [d]))
    const typing = feed(state, key({ kind: 'enter' }), key({ kind: 'enter' }), char('o'), char('k')).state
    assert.deepEqual(typing.compose, { to: { kind: 'decision', id: d.decisionId }, text: 'ok' })
    assert.deepEqual(feed(typing, key({ kind: 'enter' })).effects, [{ kind: 'run', action: { kind: 'decide', id: d.decisionId, option: 'ok' } }])
  })

  it('quits on q and ctrl-c', () => {
    assert.deepEqual(feed(base, char('q')).effects, [{ kind: 'quit' }])
    assert.deepEqual(feed(base, key({ kind: 'ctrl-c' })).effects, [{ kind: 'quit' }])
  })
})

describe('render', () => {
  const now = Date.parse('2026-11-10T13:00:00.000Z')
  const state = (snapshot: LsResult, cols = 100, rows = 24): WatchState =>
    feed(initialState({ cols, rows }), { type: 'snapshot', ls: snapshot }).state

  it('paints exactly rows lines, each no wider than cols once escapes are stripped', () => {
    const s = state(ls([peer('engineer-1', { state: 'working' }), peer('engineer-2')], [decision('x', '2026-11-10T12:00:00.000Z')]), 80, 20)
    const lines = render(s, now)
    assert.equal(lines.length, 20)
    for (const line of lines) assert.ok([...strip(line)].length <= 80, strip(line))
  })

  it('shows the needs-you strip above the peers, with marks, context and doing-now', () => {
    const activity: PeerActivity = {
      peerId: 'engineer-1' as PeerId,
      lastTool: 'Edit',
      lastTarget: 'src/a.ts',
      edits: 1,
      contextTokens: 70,
      contextLimit: 100,
    }
    const text = render(state(ls([peer('engineer-1', { state: 'working' }), peer('engineer-2', { state: 'waiting_input' })], [decision('x', '2026-11-10T12:00:00.000Z')], [activity])), now)
      .map(strip)
      .join('\n')
    assert.match(text, /NEEDS YOU \(2\)/)
    assert.match(text, /! ship x\?/)
    assert.match(text, /\? engineer-2 is waiting/)
    assert.match(text, /● engineer-1 .*Edit src\/a\.ts.* 70%!/)
    assert.ok(text.indexOf('NEEDS YOU') < text.indexOf('PEERS'))
  })

  it('says nothing waits when nothing does, and waits for the daemon before a snapshot', () => {
    assert.match(render(state(ls([peer('a')])), now).map(strip).join('\n'), /nothing waits on you/)
    assert.match(render(initialState({ cols: 60, rows: 10 }), now).map(strip).join('\n'), /waiting for fleetd/)
  })

  it("shows the focused peer's timeline in the detail pane, newest last", () => {
    const base = state(ls([peer('a', { state: 'working' })]))
    const filled = feed(
      base,
      { type: 'frame', frame: { stream: 'line', seq: 1, at: 't', peerId: 'a' as PeerId, line: { kind: 'text', text: 'thinking about it' } } },
      { type: 'frame', frame: { stream: 'line', seq: 2, at: 't', peerId: 'a' as PeerId, line: { kind: 'tool', tool: 'Read', summary: 'x.ts' } } },
    ).state
    const text = render(filled, now).map(strip).join('\n')
    assert.ok(text.indexOf('thinking about it') < text.indexOf('⚙ Read x.ts'))
  })

  it('shows the menu in place of the detail', () => {
    const opened = feed(state(ls([peer('a', { state: 'held' })])), key({ kind: 'enter' })).state
    assert.match(render(opened, now).map(strip).join('\n'), /Reopen the native session/)
  })

  it('keeps only the newest lines that fit', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ seq: i, kind: 'line' as const, line: { kind: 'text' as const, text: `line ${String(i)}` } }))
    assert.deepEqual(detailLines(items, 20, 3), ['line 7', 'line 8', 'line 9'])
  })

  it('renders --once with no escapes', () => {
    const lines = renderOnce(ls([peer('engineer-1', { state: 'working' })], [decision('x', '2026-11-10T12:00:00.000Z')]), now)
    assert.equal(lines[0], 'NEEDS YOU (1)')
    assert.ok(lines.every((line) => !line.includes('\u001b')))
    assert.match(lines.join('\n'), /● engineer-1/)
  })
})

describe('a peer cannot paint the terminal (TASK-105)', () => {
  const now = Date.parse('2026-11-10T13:00:00.000Z')
  const state = (snapshot: LsResult, cols = 100, rows = 24): WatchState =>
    feed(initialState({ cols, rows }), { type: 'snapshot', ls: snapshot }).state

  /**
   * What a peer would send to take the screen: wipe it, home the cursor, set the
   * window title (OSC 0), and set the clipboard (OSC 52). None of these are text.
   */
  const PAYLOAD = '\u001b[2J\u001b[1;1H\u001b]0;pwned\u0007\u001b]52;c;cGF5bG9hZA==\u0007evil'

  /**
   * Everything on a line that is not this view's own SGR colour. The view paints
   * with `\u001b[<digits>m` and nothing else, so anything left over here is a
   * sequence the peer chose — which is the whole of what this checks.
   */
  const foreign = (line: string): readonly string[] => line.replace(/\u001b\[[0-9;]*m/g, '').match(/[\u0000-\u001f\u007f-\u009f]/g) ?? []

  it('strips an escape payload from the activity the peer reports about itself', () => {
    // `lastTarget` is a path the peer's own tool call named — the most direct
    // route from a peer to this screen, and the one TASK-100 found in `view`.
    const activity: PeerActivity = { peerId: 'a' as PeerId, lastTool: 'Read', lastTarget: PAYLOAD, edits: 1 }
    const lines = render(state(ls([peer('a', { state: 'working' })], [], [activity])), now)
    assert.deepEqual(lines.flatMap(foreign), [])
    assert.match(lines.map(strip).join('\n'), /Read evil/)
  })

  it('strips it from the timeline, the tool summary, and the mail it was sent', () => {
    const filled = feed(
      state(ls([peer('a', { state: 'working' })])),
      { type: 'frame', frame: { stream: 'line', seq: 1, at: 't', peerId: 'a' as PeerId, line: { kind: 'text', text: PAYLOAD } } },
      { type: 'frame', frame: { stream: 'line', seq: 2, at: 't', peerId: 'a' as PeerId, line: { kind: 'tool', tool: 'Read', summary: PAYLOAD } } },
      { type: 'frame', frame: { stream: 'line', seq: 3, at: 't', peerId: 'a' as PeerId, line: { kind: 'turn', phase: 'ended', reason: PAYLOAD as never } } },
      { type: 'frame', frame: { stream: 'row', seq: 4, at: 't', row: { kind: 'mail', phase: 'delivered', msgId: 'm-1' as never, to: 'a' as PeerId, from: PAYLOAD } } },
    ).state
    assert.deepEqual(render(filled, now).flatMap(foreign), [])
  })

  it('strips it from the question and the options a peer asks with', () => {
    const asked: Decision = { ...decision('x', '2026-11-10T12:00:00.000Z', [PAYLOAD, 'hold']), question: PAYLOAD }
    const lines = render(state(ls([peer('a')], [asked])), now)
    assert.deepEqual(lines.flatMap(foreign), [])
    assert.match(lines.map(strip).join('\n'), /evil/)
  })

  it('strips it from a peer id, which arrives from the profile and the peer both', () => {
    const lines = render(state(ls([peer(`a${PAYLOAD}`)])), now)
    assert.deepEqual(lines.flatMap(foreign), [])
  })

  it('strips it from the detail header, which repeats role, provider and model', () => {
    const lines = render(state(ls([peer('a', { role: PAYLOAD as never, providerId: PAYLOAD as never, model: PAYLOAD as never })])), now)
    assert.deepEqual(lines.flatMap(foreign), [])
  })

  it('strips it from --once too, which is the path that reaches a transcript', () => {
    // `--once` prints no escapes of its own, so its lines can be held to the
    // stricter rule: nothing control at all, and no sequence to strip first.
    const activity: PeerActivity = { peerId: 'a' as PeerId, lastTool: PAYLOAD, lastTarget: PAYLOAD, edits: 1 }
    const lines = renderOnce(ls([peer(`a${PAYLOAD}`, { state: 'working' })], [{ ...decision('x', '2026-11-10T12:00:00.000Z'), question: PAYLOAD }], [activity]), now)
    assert.deepEqual(lines.flatMap(foreign), [])
    for (const line of lines) assert.doesNotMatch(line, /\u001b/, line)
  })
})

describe('fleet watch --once', () => {
  it('prints the strip and the table from one ls', async () => {
    const out: string[] = []
    const code = await run(['node', 'fleet', 'watch', '--once', '--socket', '/s'], {
      call: () => (async (method: DaemonMethod) => {
        assert.equal(method, 'ls')
        return ls([peer('engineer-1', { state: 'working' })])
      }) as DaemonCaller,
      out: (text) => out.push(text),
      err: () => undefined,
      env: {},
    })
    assert.equal(code, 0)
    assert.match(out.join('\n'), /PEERS \(1\)/)
  })

  it('refuses the live watch when the build has no terminal', async () => {
    const err: string[] = []
    const code = await run(['node', 'fleet', 'watch', '--socket', '/s'], { call: () => (() => Promise.reject(new Error('no'))) as DaemonCaller, out: () => undefined, err: (t) => err.push(t), env: {} })
    assert.equal(code, 1)
    assert.match(err.join('\n'), /no terminal to watch in/)
  })
})

describe('the terminal loop', () => {
  const harness = (snapshot: LsResult) => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin })
    const written: string[] = []
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 20 })
    stdout.on('data', (chunk: Buffer) => written.push(chunk.toString()))
    const calls: { method: string; params: unknown }[] = []
    const call = (async (method: DaemonMethod, params: unknown) => {
      calls.push({ method, params })
      if (method === 'ls') return snapshot
      if (method === 'peer.interrupt') return { peerId: 'a', interrupted: true }
      return {}
    }) as DaemonCaller
    const frames: { onFrame: (f: WatchFrame) => void; onClose: () => void; since: number | undefined; closed: boolean }[] = []
    const openWatch: OpenWatch = ({ onFrame, onClose, since }) => {
      const entry = { onFrame, onClose: () => onClose(), since, closed: false }
      frames.push(entry)
      return { close: () => void (entry.closed = true) }
    }
    return { stdin, stdout, written, calls, call, frames, openWatch }
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

  it('paints, follows frames, runs a menu action and quits cleanly', async () => {
    const h = harness(ls([peer('a', { state: 'working' })]))
    const done = runWatch({ socketPath: '/s', call: h.call, takeover: undefined, env: {}, stdin: h.stdin, stdout: h.stdout, openWatch: h.openWatch, refreshMs: 60_000 })
    await settle()
    h.frames[0]?.onFrame({ stream: 'line', seq: 1, at: 't', peerId: 'a' as PeerId, line: { kind: 'text', text: 'working away' } })
    await settle()
    assert.match(h.written.join(''), /working away/)
    // enter → menu; down, down → interrupt; enter
    h.stdin.write('\r')
    h.stdin.write('\u001b[B\u001b[B')
    h.stdin.write('\r')
    await settle()
    assert.ok(h.calls.some((c) => c.method === 'peer.interrupt'))
    h.stdin.write('q')
    await done
    assert.equal(h.frames[0]?.closed, true)
    assert.match(h.written.join(''), /\u001b\[\?1049l/)
  })

  it('gives the terminal to a takeover, hands the peer back, and repaints what is true after', async () => {
    const held = {
      peerId: 'a',
      providerId: 'claude',
      sessionRef: 'r',
      cwd: '/w',
      model: 'm',
      env: {},
      command: { executable: 'claude', args: ['--resume', 'r'] },
      pendingMessages: 0,
    }
    const h = harness(ls([peer('a', { state: 'idle' })]))
    const order: string[] = []
    const call = (async (method: DaemonMethod, params: unknown) => {
      order.push(method)
      if (method === 'peer.hold') return held
      if (method === 'peer.release') return { peerId: 'a', resumed: true }
      return h.call(method, params as never)
    }) as DaemonCaller
    let screenDuringTakeover = ''
    const takeover = async (): Promise<{ code: number | null; signal: string | null }> => {
      order.push('takeover')
      screenDuringTakeover = h.written.join('')
      h.written.length = 0
      return { code: 0, signal: null }
    }
    const done = runWatch({ socketPath: '/s', call, takeover, env: {}, stdin: h.stdin, stdout: h.stdout, openWatch: h.openWatch, refreshMs: 60_000 })
    await settle()
    h.stdin.write('\r')
    h.stdin.write('\r')
    await settle()
    assert.deepEqual(order.filter((m) => m !== 'ls'), ['peer.hold', 'takeover', 'peer.release'])
    assert.match(screenDuringTakeover, /\u001b\[\?1049l/, 'the alternate screen was given back before the child ran')
    const after = h.written.join('')
    assert.match(after, /\u001b\[\?1049h/, 'and taken again after')
    assert.match(after, /a handed back/, 'with the result painted, not a stale screen')
    h.stdin.write('q')
    await done
  })

  describe('attach while the hold waits (TASK-116)', () => {
    const held = {
      peerId: 'a',
      providerId: 'claude',
      sessionRef: 'r',
      cwd: '/w',
      model: 'm',
      env: {},
      command: { executable: 'claude', args: ['--resume', 'r'] },
      pendingMessages: 0,
    }

    /** A watch on a peer whose turn does not end until the test says so, logging raw-mode changes and calls in order. */
    const waiting = () => {
      const log: string[] = []
      const stdin = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: (mode: boolean) => {
          log.push(`raw:${String(mode)}`)
          return stdin
        },
      })
      const originalPause = stdin.pause.bind(stdin)
      stdin.pause = () => {
        log.push('pause')
        return originalPause()
      }
      const h = harness(ls([peer('a', { state: 'working' })]))
      let release: (() => void) | undefined
      let holdSignal: AbortSignal | undefined
      const call = (async (method: DaemonMethod, params: unknown, options?: { signal?: AbortSignal }) => {
        if (method === 'peer.hold') {
          log.push('hold')
          holdSignal = options?.signal
          await new Promise<void>((resolve, reject) => {
            release = resolve
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason ?? new Error('aborted')))
          })
          return held
        }
        if (method === 'peer.release') {
          log.push('release')
          return { peerId: 'a', resumed: true }
        }
        return h.call(method, params as never)
      }) as DaemonCaller
      const takeover = async (): Promise<{ code: number | null; signal: string | null }> => {
        log.push('takeover')
        return { code: 0, signal: null }
      }
      const done = runWatch({ socketPath: '/s', call, takeover, env: {}, stdin, stdout: h.stdout, openWatch: h.openWatch, refreshMs: 60_000 })
      // A watch that does not quit fails the test instead of hanging the run.
      const quits = Promise.race([done, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the watch did not quit')), 500))])
      return { h, stdin, log, done: quits, release: () => release?.(), signal: () => holdSignal }
    }

    const attach = async (w: ReturnType<typeof waiting>) => {
      await settle()
      w.stdin.write('\r') // the menu
      w.stdin.write('\r') // the first item: attach
      await settle()
    }

    it('keeps the terminal raw and reading keys while the hold waits', async () => {
      const w = waiting()
      await attach(w)

      assert.ok(w.log.includes('hold'), 'the hold is waiting')
      assert.equal(w.log.filter((entry) => entry === 'raw:false' || entry === 'pause').length, 0, 'raw mode and the reader are kept for the wait')
      w.release()
      await settle()
      w.stdin.write('q')
      await w.done
    })

    it('cancels the wait on Esc, aborts the request, and says the peer keeps running', async () => {
      const w = waiting()
      await attach(w)

      w.stdin.write('\u001b')
      await settle()
      await settle()

      assert.equal(w.signal()?.aborted, true, 'the hold request was dropped')
      assert.ok(!w.log.includes('takeover') && !w.log.includes('release'), 'nothing was taken over or released')
      assert.match(w.h.written.join(''), /cancelled, a keeps running/)
      w.stdin.write('q')
      await w.done
    })

    it('cancels on q too, and does not quit the watch', async () => {
      const w = waiting()
      await attach(w)

      w.stdin.write('q')
      await settle()
      await settle()

      assert.equal(w.signal()?.aborted, true)
      assert.match(w.h.written.join(''), /cancelled, a keeps running/)
      w.stdin.write('q') // the watch is back and this one quits it
      await w.done
    })

    it('drops raw mode only right before the takeover, once the hold has answered', async () => {
      const w = waiting()
      await attach(w)
      w.log.length = 0
      w.release()
      await settle()

      assert.deepEqual(w.log.filter((entry) => entry !== 'raw:true'), ['raw:false', 'pause', 'takeover', 'release'])
      w.stdin.write('q')
      await w.done
    })
  })

  it('reconnects a lost stream from the newest seq it saw', async () => {
    const h = harness(ls([peer('a')]))
    const done = runWatch({ socketPath: '/s', call: h.call, takeover: undefined, env: {}, stdin: h.stdin, stdout: h.stdout, openWatch: h.openWatch, reconnectMs: 5, refreshMs: 60_000 })
    await settle()
    h.frames[0]?.onFrame({ stream: 'line', seq: 7, at: 't', peerId: 'a' as PeerId, line: { kind: 'text', text: 'x' } })
    h.frames[0]?.onFrame({ stream: 'end', reason: 'dropped' })
    h.frames[0]?.onClose()
    await settle()
    assert.equal(h.frames.length, 2)
    assert.equal(h.frames[1]?.since, 7)
    h.stdin.write('q')
    await done
  })
})

describe('the detail pane styles what it shows', () => {
  const plain = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, '')

  it('shows what a message said under a coloured header, indented and wrapped to the pane', () => {
    const lines = detailLines(
      [
        { seq: 1, kind: 'mail', phase: 'sent', from: 'pm', mailKind: 'brief', text: 'Brief v9 — engineer-1\nWork: a title long enough to wrap' },
        { seq: 2, kind: 'mail', phase: 'delivered' },
      ],
      24,
      20,
    )
    assert.equal(plain(lines[0] ?? ''), '✉ brief from pm')
    assert.ok((lines[0] ?? '').startsWith('\u001b[1;36m'), 'the header is coloured')
    assert.ok(lines.slice(1, -1).every((line) => plain(line).startsWith('  ')), 'the body is indented')
    assert.ok(lines.every((line) => [...plain(line)].length <= 24), 'no line is wider than the pane')
    assert.equal(plain(lines.at(-1) ?? ''), '  ✓ delivered')
  })
})
