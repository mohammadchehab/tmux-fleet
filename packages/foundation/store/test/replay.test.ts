/**
 * Replay determinism (architecture §3, §5.4). The log is the source of truth,
 * so a projection is only worth having if rebuilding it lands on the same rows
 * — and if a second store fed the same events lands there too. This is the
 * property the whole event-sourced design rests on: `append` and `rebuild` run
 * the same reducer over the same sequence.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteStore, type EventStore } from '../src/index.ts'
import { fixedClock, fixtureLog, readAll, tempStorePath } from './fixtures.ts'

const open = (): Promise<EventStore> => openSqliteStore({ path: tempStorePath(), clock: fixedClock })

test('rebuilding the projections reproduces exactly the rows append wrote', async () => {
  const store = await open()
  const seqs = await store.append(fixtureLog())
  const before = await readAll(store)

  await store.rebuild()
  assert.deepEqual(await readAll(store), before)

  // A rebuild is a projection step, never a rewrite of the log.
  assert.deepEqual(
    (await store.read(1)).map((event) => event.seq),
    seqs,
  )

  // And it is idempotent: replaying twice is replaying once.
  await store.rebuild()
  assert.deepEqual(await readAll(store), before)

  await store.close()
})

test('two stores fed the same log agree, down to the sequence numbers', async () => {
  const first = await open()
  const second = await open()

  const firstSeqs = await first.append(fixtureLog())
  const secondSeqs = await second.append(fixtureLog())
  assert.deepEqual(secondSeqs, firstSeqs, 'seq is allocated by the log, so the same log has the same shape')
  assert.deepEqual(await readAll(second), await readAll(first))

  // ...and so does a rebuild of either one.
  await second.rebuild()
  assert.deepEqual(await readAll(second), await readAll(first))

  await first.close()
  await second.close()
})

test('a snapshot survives a backup and reads identically through a second handle', async () => {
  const store = await open()
  await store.append(fixtureLog())
  const original = await readAll(store)

  const copyPath = tempStorePath()
  await store.backup(copyPath)
  await store.close()

  const copy = await openSqliteStore({ path: copyPath, clock: fixedClock })
  assert.deepEqual(await readAll(copy), original)

  // The copy is a full log, not just rows: rebuilding it from the events alone
  // still lands on the same read model.
  await copy.rebuild()
  assert.deepEqual(await readAll(copy), original)
  await copy.close()
})
