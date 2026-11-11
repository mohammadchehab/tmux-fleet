/** The display feed: bounded, never stored, and a slow watcher is dropped (watch-and-attach §6). */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PeerId } from '@fleet/foundation-core'
import { daemonProtocolVersion, displayLineMaxChars, type WatchFrame } from '@fleet/foundation-contracts'

import { createDisplayFeed, rowOf } from '../src/execution/display.ts'

const a = 'engineer-1' as PeerId
const b = 'architect-1' as PeerId

const clock = () => {
  let n = 0
  return () => `2026-11-11T08:00:${String(n++ % 60).padStart(2, '0')}.000Z`
}

/**
 * The quiet timer, driven by the test instead of by the machine (TASK-124): `tick`
 * is the only thing that lets a scheduled flush run, so "the line was not cut
 * mid-word" is a fact about the feed and not about how busy the box was.
 */
const fakeQuiet = () => {
  let now = 0
  let nextId = 0
  let due: { readonly at: number; readonly id: number; readonly run: () => void }[] = []
  return {
    later: (run: () => void, ms: number): (() => void) => {
      const id = (nextId += 1)
      due.push({ at: now + ms, id, run })
      return () => {
        due = due.filter((entry) => entry.id !== id)
      }
    },
    /** Move time on, running every flush that comes due — in the order they would have. */
    tick: (ms: number): void => {
      now += ms
      for (;;) {
        const ready = due.filter((entry) => entry.at <= now).sort((left, right) => left.at - right.at)[0]
        if (ready === undefined) return
        due = due.filter((entry) => entry.id !== ready.id)
        ready.run()
      }
    },
    /** How many flushes are waiting: one push cancels the one before it. */
    get waiting(): number {
      return due.length
    },
  }
}

/** Everything a watcher holds right now, read without waiting for more. */
const drain = async (iterator: AsyncIterator<WatchFrame>, count: number): Promise<WatchFrame[]> => {
  const out: WatchFrame[] = []
  for (let i = 0; i < count; i += 1) {
    const next = await iterator.next()
    if (next.done === true) break
    out.push(next.value)
  }
  return out
}

/** Everything up to and including `ready`: the buffered history, however long it is. */
const history = async (iterator: AsyncIterator<WatchFrame>): Promise<WatchFrame[]> => {
  const out: WatchFrame[] = []
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) return out
    out.push(next.value)
    if (next.value.stream === 'ready') return out
  }
}

const texts = (frames: readonly WatchFrame[]): string[] =>
  frames.flatMap((frame) => (frame.stream === 'line' && frame.line.kind === 'text' ? [frame.line.text] : []))

test('deltas are gathered into the lines a person would read, and a tool or a turn ends the sentence before it', async () => {
  const feed = createDisplayFeed({ now: clock() })
  feed.push(a, { kind: 'text', text: 'Hel' })
  feed.push(a, { kind: 'text', text: 'lo\nwor' })
  feed.push(a, { kind: 'text', text: 'ld' })
  feed.push(a, { kind: 'tool', tool: 'Bash', summary: 'ls' })
  feed.push(a, { kind: 'text', text: 'done' })
  feed.push(a, { kind: 'turn', phase: 'ended', reason: 'completed' })

  const frames = await drain(feed.watch({})[Symbol.asyncIterator](), 6)
  assert.deepEqual(
    frames.map((frame) => (frame.stream === 'line' ? frame.line.kind === 'text' ? frame.line.text : frame.line.kind === 'tool' ? `tool:${frame.line.tool}` : `turn:${frame.line.phase}` : frame.stream)),
    ['Hello', 'world', 'tool:Bash', 'done', 'turn:ended', 'ready'],
  )
})

test('gathered text flushes by itself after the flush interval', async () => {
  // The flush timer is unref'd on purpose (the daemon has its own reasons to stay alive), so this
  // test holds the loop itself; without it the runner finds nothing pending and cancels the test
  // with "Promise resolution is still pending but the event loop has already resolved".
  const holding = setInterval(() => undefined, 1_000)
  try {
    const feed = createDisplayFeed({ flushMs: 10 })
    const iterator = feed.watch({})[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value?.stream, 'ready')
    feed.push(a, { kind: 'text', text: 'no newline yet' })
    const next = await iterator.next()
    assert.deepEqual(texts([next.value as WatchFrame]), ['no newline yet'])
  } finally {
    clearInterval(holding)
  }
})

test('a line still being written is not cut mid-word: the flush timer is quiet time, not a deadline', async () => {
  // Six deltas 15 ms apart run 75 ms in all: past one flush interval, inside each gap.
  // The quiet timer is the test's own, so the gaps are the test's too — with a real
  // one a starved event loop made the gap longer than the window and the feed cut the
  // line, which is a test failing on how busy the machine was, not on what it asserts.
  const quiet = fakeQuiet()
  const feed = createDisplayFeed({ flushMs: 40, later: quiet.later })
  const iterator = feed.watch({})[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.stream, 'ready')
  for (const piece of ['I will ', 'start by ', 'rea', 'ding ', 'the ', 'file']) {
    feed.push(a, { kind: 'text', text: piece })
    quiet.tick(15)
    assert.equal(quiet.waiting, 1, 'one quiet timer, the one the latest delta set')
  }
  quiet.tick(40)
  assert.equal(quiet.waiting, 0, 'and it ran once the writing stopped')

  const next = await iterator.next()
  assert.deepEqual(texts([next.value as WatchFrame]), ['I will start by reading the file'])
})

test('a line is cut to the width budget before it is buffered, and a flood is counted rather than shown', async () => {
  const feed = createDisplayFeed({})
  feed.push(a, { kind: 'text', text: `${'x'.repeat(displayLineMaxChars + 300)}\n` })
  const [first, second] = texts(await history(feed.watch({})[Symbol.asyncIterator]()))
  assert.equal(first?.length, displayLineMaxChars, 'cut at the budget')
  assert.equal(second?.length, 300, 'the rest is the next line, not lost or longer than the budget')

  const big = createDisplayFeed({})
  big.push(a, { kind: 'text', text: 'y'.repeat(5_000_000) })
  assert.ok(big.seq <= 52, `a 5 MB print made ${String(big.seq)} lines, not 12 500`)
  const shown = texts(await history(big.watch({})[Symbol.asyncIterator]()))
  assert.match(shown.at(-1) ?? '', /more characters not shown/)
  assert.ok(shown.every((line) => line.length <= displayLineMaxChars + 1))
})

test('each peer keeps the last N lines, and `from` says where the history now begins', async () => {
  const feed = createDisplayFeed({ perPeer: 5 })
  for (let i = 1; i <= 8; i += 1) feed.push(a, { kind: 'tool', tool: `t${String(i)}` })
  feed.push(b, { kind: 'tool', tool: 'other' })
  const frames = await drain(feed.watch({ peerId: a })[Symbol.asyncIterator](), 6)
  assert.deepEqual(
    frames.filter((f) => f.stream === 'line').map((f) => (f.stream === 'line' && f.line.kind === 'tool' ? f.line.tool : '')),
    ['t4', 't5', 't6', 't7', 't8'],
    'the last five, for that peer only',
  )
  const ready = frames.at(-1)
  assert.equal(ready?.stream, 'ready')
  if (ready?.stream === 'ready') {
    assert.equal(ready.seq, 9)
    assert.equal(ready.from, 4, 'the ring dropped t1..t3')
    assert.equal(ready.protocolVersion, daemonProtocolVersion)
  }
})

test('a reconnect with since gets only what it missed, rows included, in seq order', async () => {
  const feed = createDisplayFeed({ now: clock() })
  feed.push(a, { kind: 'tool', tool: 'one' })
  feed.row({ kind: 'state', peerId: a, state: 'working' })
  feed.push(a, { kind: 'tool', tool: 'two' })
  const iterator = feed.watch({ since: 1 })[Symbol.asyncIterator]()
  const frames = await drain(iterator, 3)
  assert.deepEqual(
    frames.map((f) => (f.stream === 'row' ? `row${String(f.seq)}` : f.stream === 'line' ? `line${String(f.seq)}` : f.stream)),
    ['row2', 'line3', 'ready'],
  )
  // And then it is live: the next push arrives without asking.
  feed.push(a, { kind: 'tool', tool: 'three' })
  const live = (await iterator.next()).value as WatchFrame
  assert.equal(live.stream === 'line' && live.line.kind === 'tool' ? live.line.tool : '', 'three')
})

test('a watch of one peer still sees every row, and none of the other peer’s lines', async () => {
  const feed = createDisplayFeed({})
  const iterator = feed.watch({ peerId: a })[Symbol.asyncIterator]()
  await iterator.next() // ready
  feed.push(b, { kind: 'tool', tool: 'theirs' })
  feed.row({ kind: 'state', peerId: b, state: 'idle' })
  feed.push(a, { kind: 'tool', tool: 'mine' })
  const got = await drain(iterator, 2)
  assert.deepEqual(got.map((f) => f.stream), ['row', 'line'])
})

test('a watcher that falls behind is dropped with an end frame, and the others and the feed are untouched', async () => {
  const feed = createDisplayFeed({ maxQueued: 10, perPeer: 50 })
  const slow = feed.watch({})[Symbol.asyncIterator]()
  const quick = feed.watch({})[Symbol.asyncIterator]()
  await quick.next()
  const got: WatchFrame[] = []
  for (let i = 0; i < 30; i += 1) {
    feed.push(a, { kind: 'tool', tool: `t${String(i)}` })
    got.push((await quick.next()).value as WatchFrame) // keeps up
  }
  assert.equal(got.length, 30)
  assert.equal(feed.seq, 30, 'the peer’s lines were all taken')

  // The slow one never read: it holds `ready` and 9 lines, then is told it was dropped.
  const held = await drain(slow, 40)
  assert.equal(held.at(-1)?.stream, 'end')
  const end = held.at(-1)
  assert.equal(end?.stream === 'end' ? end.reason : '', 'dropped')
  assert.equal((await slow.next()).done, true, 'and then the stream is over')
})

test('closeAll ends every watcher with the reason, after what they already hold', async () => {
  const feed = createDisplayFeed({})
  feed.push(a, { kind: 'tool', tool: 'x' })
  const iterator = feed.watch({})[Symbol.asyncIterator]()
  feed.closeAll('shutdown')
  const frames = await drain(iterator, 5)
  assert.deepEqual(frames.map((f) => f.stream), ['line', 'ready', 'end'])
  assert.equal((await iterator.next()).done, true)
})

test('a client that stops reading unsubscribes, and later pushes cost it nothing', async () => {
  const feed = createDisplayFeed({ maxQueued: 3 })
  const iterator = feed.watch({})[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return?.()
  for (let i = 0; i < 100; i += 1) feed.push(a, { kind: 'tool', tool: 'x' })
  assert.equal((await iterator.next()).done, true)
})

test('only the store facts a view shows become rows, and a long question is cut', () => {
  const at = '2026-11-11T08:00:00.000Z'
  const event = (type: string, data: Record<string, unknown>) => ({ seq: 1, ts: at, type, subject: 'x', actor: 'user', data }) as never
  assert.deepEqual(rowOf(event('peer.state_changed', { peerId: a, state: 'idle', sessionId: 'ses_0123456789abcdef' })), { kind: 'state', peerId: a, state: 'idle' })
  assert.deepEqual(rowOf(event('message.sent', { msgId: 'msg_0123456789abcdef', to: a, from: 'pm', kind: 'info', briefVersion: 1, body: 'the body is not shown' })), {
    kind: 'mail',
    phase: 'sent',
    msgId: 'msg_0123456789abcdef',
    to: a,
    from: 'pm',
  })
  assert.deepEqual(rowOf(event('message.delivered', { msgId: 'msg_0123456789abcdef', to: a, sessionId: 'ses_0123456789abcdef' })), {
    kind: 'mail',
    phase: 'delivered',
    msgId: 'msg_0123456789abcdef',
    to: a,
  })
  const long = rowOf(event('decision.requested', { decisionId: 'dec_0123456789abcdef', question: 'q'.repeat(2_000) }))
  assert.equal(long?.kind === 'decision' ? long.question?.length : 0, displayLineMaxChars + 1)
  assert.deepEqual(rowOf(event('decision.answered', { decisionId: 'dec_0123456789abcdef', source: 'user' })), { kind: 'decision', phase: 'answered', decisionId: 'dec_0123456789abcdef' })
  assert.equal(rowOf(event('peer.tool_used', { peerId: a, tool: 'Bash' })), undefined)
  assert.equal(rowOf(event('routine.started', {})), undefined)
})
