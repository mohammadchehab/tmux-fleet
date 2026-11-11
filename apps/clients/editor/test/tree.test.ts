/**
 * The tree model (§4): the elements keep their identity, and a poll reports the
 * rows whose words moved.
 *
 * The identity test is the one that matters. `onDidChangeTreeData.fire(item)`
 * resolves by object identity, so a model that rebuilt its items per poll would
 * draw a correct tree and refresh nothing — silently, since the next structural
 * refresh would paper over it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rowsOf } from '../src/rows.ts'
import { reconcile, TreeModel } from '../src/tree.ts'
import { activityOf, decisionOf, lsOf, peerOf } from './fixtures.ts'

const rowsFor = (parts: Parameters<typeof lsOf>[0]) => rowsOf(lsOf(parts))

test('a peer row is the same object across polls, and its new words are in it', () => {
  const model = new TreeModel()
  model.apply({ rows: rowsFor({ peers: [peerOf('engineer-1', 'working')] }) })
  const first = model.children(model.root().find((item) => item.section === 'peers'))
  const before = first[0]
  assert.ok(before !== undefined)

  const refresh = model.apply({
    rows: rowsFor({ peers: [peerOf('engineer-1', 'working')], activity: [activityOf('engineer-1', 'Read', 'a.ts')] }),
  })

  const after = model.children(model.root().find((item) => item.section === 'peers'))[0]
  assert.equal(after, before, 'the row must be the same object or fire() is a no-op')
  assert.equal(before.description, 'Read a.ts')
  assert.equal(refresh.structural, false)
  assert.deepEqual(refresh.changed, [before])
})

test('a poll that changed nothing reports nothing', () => {
  const model = new TreeModel()
  const rows = rowsFor({ peers: [peerOf('engineer-1')] })
  model.apply({ rows })
  const refresh = model.apply({ rows })
  assert.equal(refresh.structural, false)
  assert.deepEqual(refresh.changed, [])
})

test('a peer arriving or leaving is structural', () => {
  const model = new TreeModel()
  model.apply({ rows: rowsFor({ peers: [peerOf('a')] }) })

  const added = model.apply({ rows: rowsFor({ peers: [peerOf('a'), peerOf('b')] }) })
  assert.equal(added.structural, true)

  const removed = model.apply({ rows: rowsFor({ peers: [peerOf('a')] }) })
  assert.equal(removed.structural, true)
})

test('a reorder is structural: the tree must re-read the section, not one row', () => {
  const model = new TreeModel()
  model.apply({ rows: rowsFor({ peers: [peerOf('a'), peerOf('b')] }) })
  const peers = model.children(model.root()[1])
  const refresh = reconcile(peers, [...peers].reverse())
  assert.equal(refresh.structural, true)
})

test('the needs-you count is on the section, and a changed count refreshes that row only', () => {
  const model = new TreeModel()
  model.apply({ rows: rowsFor({}) })
  const section = model.root().find((item) => item.section === 'needs-you')
  assert.ok(section !== undefined)
  assert.equal(section.label, 'Needs you (0)')

  const refresh = model.apply({ rows: rowsFor({ decisions: [decisionOf('d-1')] }) })
  assert.equal(section.label, 'Needs you (1)')
  assert.ok(refresh.changed.includes(section))
})

test('a notice sits above the rows and does not replace them', () => {
  const model = new TreeModel()
  model.apply({ rows: rowsFor({ peers: [peerOf('a')] }) })
  const refresh = model.apply({
    rows: rowsFor({ peers: [peerOf('a')] }),
    notice: { label: 'Disconnected', description: 'no daemon', tooltip: 'no daemon' },
  })

  assert.equal(refresh.structural, true, 'a notice appearing changes the root shape')
  assert.deepEqual(
    model.root().map((item) => item.id),
    ['notice', 'section:needs-you', 'section:peers'],
  )
  // The rows are still there, which is the point: a lost daemon must not look
  // like an empty fleet.
  assert.equal(model.children(model.root()[2])[0]?.label, 'a')
})

test('with no rows at all, the sections are hidden and the notice is the tree', () => {
  const model = new TreeModel()
  model.apply({ rows: undefined, notice: { label: 'No fleet is running', description: '', tooltip: '' } })
  assert.deepEqual(
    model.root().map((item) => item.id),
    ['notice'],
  )
})

test('a leaving notice is structural, and the sections come back', () => {
  const model = new TreeModel()
  model.apply({ rows: rowsFor({}), notice: { label: 'Starting…', description: '', tooltip: '' } })
  const refresh = model.apply({ rows: rowsFor({}) })
  assert.equal(refresh.structural, true)
  assert.deepEqual(
    model.root().map((item) => item.id),
    ['section:needs-you', 'section:peers'],
  )
})

test('a changed notice is one row refreshed, not a whole-tree redraw', () => {
  const model = new TreeModel()
  model.apply({ rows: undefined, notice: { label: 'Disconnected', description: 'one', tooltip: '' } })
  const refresh = model.apply({ rows: undefined, notice: { label: 'Disconnected', description: 'two', tooltip: '' } })
  assert.equal(refresh.structural, false)
  assert.equal(refresh.changed.length, 1)
  assert.equal(refresh.changed[0]?.description, 'two')
})

test('a decision row carries its command, and answering it is a click away', () => {
  const model = new TreeModel()
  model.apply({ rows: rowsFor({ decisions: [decisionOf('d-1', 'Ship it?')] }) })
  const row = model.children(model.root()[0])[0]
  assert.ok(row !== undefined)
  assert.equal(row.commandId, 'fleet.decision.answer')
  assert.equal(row.commandArg, 'd-1')
  assert.equal(row.contextValue, 'need-you.decision')
})

test('a peer row is classified by standing, which is what the menu clauses match on', () => {
  const model = new TreeModel()
  model.apply({ rows: rowsFor({ peers: [peerOf('a', 'working'), peerOf('b', 'ended')] }) })
  const [a, b] = model.children(model.root()[1])
  assert.equal(a?.contextValue, 'peer.running')
  assert.equal(b?.contextValue, 'peer.stopped')
})
