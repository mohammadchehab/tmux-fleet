/**
 * `EventStore` over `node:sqlite` (architecture §3, §5.4, §15 phase 1): the
 * append boundary is strict and atomic, a reader sees a total order, and the
 * same object satisfies the narrow ports the Mailbox was written against.
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { FleetError, type PeerId } from '@fleet/foundation-core'
import type { AppendEvent, EventSink, FleetEvent, MessageReader } from '@fleet/foundation-contracts'
import { openSqliteStore, type EventStore } from '../src/index.ts'
import { appendable, fixedClock, tempStorePath } from './fixtures.ts'

const open = (options: { readonly path?: string; readonly readOnly?: boolean } = {}): Promise<EventStore> =>
  openSqliteStore({ path: options.path ?? tempStorePath(), clock: fixedClock, readOnly: options.readOnly })

const threeEvents = (): readonly AppendEvent[] => [
  appendable('peer.registered.json'),
  appendable('peer.state_changed.json'),
  appendable('peer.failed.json'),
]

test('append assigns consecutive seqs, in the order given, and moves the head', async () => {
  const store = await open()
  assert.equal(await store.latestSeq(), 0, 'an empty store is at 0, not undefined')

  assert.deepEqual(await store.append(threeEvents()), [1, 2, 3])
  assert.deepEqual(await store.append([appendable('session.started.json')]), [4])
  assert.equal(await store.latestSeq(), 4)
  assert.deepEqual(await store.append([]), [], 'an empty batch writes nothing and returns no seqs')

  await store.close()
})

test('health reports the log it holds, and works on the read-only handle', async () => {
  const path = tempStorePath()
  const store = await open({ path })
  assert.deepEqual(
    await store.health(),
    { latestSeq: 0, events: 0, anomalies: 0 },
    'an empty store is healthy and at seq 0, like `latestSeq`',
  )
  await store.append(threeEvents())
  await store.close()

  // `fleet status` opens the live daemon's store read-only; a health read has to work there
  const reader = await open({ path, readOnly: true })
  assert.deepEqual(await reader.health(), { latestSeq: 3, events: 3, anomalies: 0 })
  await reader.close()
})

test('a refused batch writes nothing at all', async () => {
  const store = await open()
  await store.append([appendable('peer.registered.json')])

  const misspelt = {
    ...appendable('peer.state_changed.json'),
    data: { peerId: 'engineer-1', state: 'working', reasunn: 'turn.started' },
  } as unknown as AppendEvent

  await assert.rejects(
    () => store.append([appendable('session.started.json'), misspelt]),
    (thrown: unknown) => {
      assert.ok(thrown instanceof FleetError)
      assert.equal(thrown.code, 'invalid_input')
      assert.match(thrown.message, /\[1\] peer\.state_changed data\.reasunn: unknown field/)
      return true
    },
  )
  assert.equal(await store.latestSeq(), 1, 'the good event in a refused batch is not written either')
  await store.close()
})

test('read and iterate honour their windows, oldest first and inclusive', async () => {
  const store = await open()
  await store.append(threeEvents())
  await store.append([appendable('session.started.json'), appendable('session.ended.json')])

  assert.deepEqual((await store.read(1)).map((event) => event.seq), [1, 2, 3, 4, 5])
  assert.deepEqual((await store.read(2, 2)).map((event) => event.seq), [2, 3])
  assert.deepEqual((await store.read(9)).map((event) => event.seq), [])

  const collected = async (from: number, to?: number): Promise<number[]> => {
    const seqs: number[] = []
    for await (const event of store.iterate(from, to)) seqs.push(event.seq)
    return seqs
  }
  assert.deepEqual(await collected(1), [1, 2, 3, 4, 5])
  assert.deepEqual(await collected(2, 3), [2, 3])
  assert.deepEqual(await collected(4), [4, 5])

  await store.close()
})

test('what is read back is the event that was written, envelope and all', async () => {
  const store = await open()
  const sent = appendable('message.sent.json')
  const [seq] = await store.append([sent])
  const [stored] = await store.read(1)
  assert.deepEqual(stored, { ...sent, seq: 1 } satisfies FleetEvent)
  assert.equal(seq, 1)
  await store.close()
})

test('the store is the EventSink and MessageReader the Mailbox is written against', async () => {
  const store = await open()
  const sink: EventSink = store
  const messages: MessageReader = store.reader().messages

  await sink.append([appendable('message.sent.json')])
  const forPeer = await messages.forPeer('engineer-1' as PeerId)
  assert.equal(forPeer.length, 1)
  assert.equal(forPeer[0]?.state, 'pending', 'a sent message waits for delivery')

  await assert.rejects(() => sink.append([{ ...appendable('message.sent.json'), type: 'message.texted' } as unknown as AppendEvent]))
  await store.close()
})

test('migrate is idempotent, and a second handle on the same file sees what the first wrote', async () => {
  const path = tempStorePath()
  const first = await open({ path })
  await first.append(threeEvents())
  await first.close()

  const second = await open({ path })
  await second.migrate()
  await second.migrate()
  assert.equal(await second.latestSeq(), 3)
  assert.equal((await second.reader().peers.all()).length, 1)
  await second.close()
})

test('a read-only handle reads and refuses to write', async () => {
  const path = tempStorePath()
  const writer = await open({ path })
  await writer.append(threeEvents())
  await writer.close()

  const reader = await open({ path, readOnly: true })
  assert.equal((await reader.read(1)).length, 3, 'a read-only handle sees the log')
  assert.equal((await reader.reader().peers.all()).length, 1, 'and the projections')

  await assert.rejects(
    () => reader.append([appendable('session.started.json')]),
    (thrown: unknown) => thrown instanceof FleetError && /read-only/.test(thrown.message),
  )
  await assert.rejects(() => reader.migrate())
  await assert.rejects(() => reader.rebuild())
  await reader.close()
})

test('backup writes a readable copy and never overwrites one', async () => {
  const store = await open()
  await store.append(threeEvents())
  const target = `${tempStorePath()}.backup`

  await store.backup(target)
  const copy = new DatabaseSync(target, { readOnly: true })
  const row = copy.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
  assert.equal(Number(row.n), 3)
  copy.close()

  await assert.rejects(
    () => store.backup(target),
    (thrown: unknown) => thrown instanceof FleetError && /already exists/.test(thrown.message),
  )
  await store.close()
})

test('a closed store cannot be read from', async () => {
  const store = await open()
  await store.close()
  await assert.rejects(async () => store.read(1))
})
