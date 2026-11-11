/** The shared half of `Provider.display` (watch-and-attach §6): one mapping, and a bounded queue. */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DisplayLine, ProviderEvent } from '@fleet/foundation-contracts'
import { DisplayQueue, displayLineOf, displayQueueLimit } from '../src/display.ts'

const at = '2026-11-11T08:00:00.000Z'
const turnId = 'trn_0123456789abcdef' as never

test('a turn line for every turn.started and turn.ended, a tool line for tool.use, and nothing for the rest', () => {
  const events: ProviderEvent[] = [
    { type: 'turn.started', turnId, at },
    { type: 'tool.use', turnId, tool: 'Read', summary: 'a.ts' },
    { type: 'tool.use', turnId, tool: 'Bash' },
    { type: 'turn.ended', turnId, at, reason: 'interrupted' },
    { type: 'error', message: 'x', retryable: false },
    { type: 'session.ended', reason: 'stopped' },
    { type: 'approval.abandoned', requestId: 'r' },
  ]
  assert.deepEqual(events.map(displayLineOf), [
    { kind: 'turn', phase: 'started' },
    { kind: 'tool', tool: 'Read', summary: 'a.ts' },
    { kind: 'tool', tool: 'Bash' },
    { kind: 'turn', phase: 'ended', reason: 'interrupted' },
    undefined,
    undefined,
    undefined,
  ])
})

test('lines pushed before anyone reads are kept, and a close ends the reader after them', async () => {
  const queue = new DisplayQueue()
  queue.push({ kind: 'text', text: 'before the reader came' })
  queue.close()
  queue.push({ kind: 'text', text: 'after the close' }) // ignored
  const seen: DisplayLine[] = []
  for await (const line of queue) seen.push(line)
  assert.deepEqual(seen, [{ kind: 'text', text: 'before the reader came' }])
})

test('a reader that waits is woken by the next line and by the close', async () => {
  const queue = new DisplayQueue()
  const seen: DisplayLine[] = []
  const reading = (async () => {
    for await (const line of queue) seen.push(line)
  })()
  await new Promise((resolve) => setImmediate(resolve))
  queue.push({ kind: 'tool', tool: 'Grep' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen, [{ kind: 'tool', tool: 'Grep' }])
  queue.close()
  await reading
})

test('a reader that never comes costs a bounded queue, and loses the oldest lines first', async () => {
  const queue = new DisplayQueue()
  for (let i = 0; i < displayQueueLimit + 50; i += 1) queue.push({ kind: 'tool', tool: `t${String(i)}` })
  queue.close()
  const seen: DisplayLine[] = []
  for await (const line of queue) seen.push(line)
  assert.equal(seen.length, displayQueueLimit)
  assert.deepEqual(seen[0], { kind: 'tool', tool: 't50' })
})
