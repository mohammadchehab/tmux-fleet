/**
 * Golden fixtures for what the PM decides (architecture §5.2, §5.4, §10).
 *
 * One JSON file per action kind under `fixtures/actions/`, and one refused
 * input per kind under `fixtures/actions-invalid/`. The golden is parsed by its
 * own schema, re-parsed by the union the executor decodes a batch with, and
 * must equal itself — so the fixture is the contract's executable shape.
 *
 * The refusals are the half that keeps the goldens honest: a schema that starts
 * accepting a value it used to refuse fails here even though every golden still
 * round-trips.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { decodeStrict, parse, type Schema } from '@fleet/foundation-core'
import { pmAction, pmActionFor, pmActionKinds, type PmActionKind } from '../src/index.ts'

const fixturesDir = new URL('./fixtures/actions/', import.meta.url)
const invalidDir = new URL('./fixtures/actions-invalid/', import.meta.url)

const names = (dir: URL): readonly string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()

const fixtureFor = (kind: string): unknown => JSON.parse(readFileSync(new URL(`${kind}.json`, fixturesDir), 'utf8'))

const invalidFor = (kind: string): { input: unknown; path: string } =>
  JSON.parse(readFileSync(new URL(`${kind}.json`, invalidDir), 'utf8'))

test('fixtures cover the action kinds exactly', () => {
  assert.deepEqual(names(fixturesDir), [...pmActionKinds].sort(), 'one golden per kind, and none for a kind that is not one')
  assert.deepEqual(names(invalidDir), [...pmActionKinds].sort(), 'one refused input per kind')
})

for (const kind of pmActionKinds) {
  test(`golden: ${kind}`, () => {
    const fixture = fixtureFor(kind)
    const parsed = parse(pmActionFor(kind), fixture)
    assert.deepEqual(parsed, fixture, 'decode then encode returns the fixture unchanged')
    assert.equal(parsed.kind, kind)

    // The union the executor decodes a batch with must accept it too, and pick
    // the same variant: `kind` is the discriminant, as `type` is for events.
    const viaUnion = parse(pmAction(), fixture)
    assert.deepEqual(viaUnion, fixture)
    assert.equal(viaUnion.kind, kind)

    // Every action says what it was decided from (§5.4), or a replay cannot
    // tell "same inputs, different action" from "inputs moved".
    assert.ok(Array.isArray((parsed as { causedBy?: unknown }).causedBy), 'an action carries its causedBy')
  })
}

for (const kind of pmActionKinds) {
  test(`refused: ${kind}`, () => {
    const { input, path } = invalidFor(kind)
    assert.notDeepEqual(input, fixtureFor(kind), 'the invalid input is a mutation of the golden one')

    const result = decodeStrict(pmActionFor(kind) as Schema<unknown>, input)
    assert.equal(result.ok, false, 'the executor refuses it at its boundary')
    if (result.ok) return
    assert.equal(result.error.issues.length, 1, `one mutation, one issue: ${result.error.message}`)
    assert.equal(result.error.issues[0].path, path, 'the refusal names the field that was mutated')
  })
}

test('the union rejects a fixture whose kind was relabelled', () => {
  const fixture = fixtureFor('merge') as Record<string, unknown>
  const relabelled = { ...fixture, kind: 'retarget' }
  assert.throws(() => parse(pmAction(), relabelled), 'a merge is not a retarget because it says so')
})

test('a merge cannot ask to delete its branch (§10)', () => {
  // §10 forbids deleting a branch a stacked dependent still sits on. The action
  // has no field for it, so the executor refuses the instruction rather than
  // having to second-guess it.
  const fixture = fixtureFor('merge') as Record<string, unknown>
  const withDelete = { ...fixture, deleteBranch: true }

  const result = decodeStrict(pmActionFor('merge') as Schema<unknown>, withDelete)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(
    result.error.issues.map((issue) => issue.path),
    ['deleteBranch'],
  )
})

test('a judge question whose input is a different kind is refused', () => {
  // The two closed sets are tied together: `question` names the schema, and a
  // mismatch would hand the Judge an input it cannot answer from (§5.3).
  const fixture = fixtureFor('request_judge') as { input: Record<string, unknown> }
  const mismatched = { ...fixture, question: 'thin_card' }
  const result = decodeStrict(pmActionFor('request_judge') as Schema<unknown>, mismatched)
  assert.equal(result.ok, false, 'the question and its input must agree')
})

test('pmActionFor answers every kind, and only a kind', () => {
  for (const kind of pmActionKinds) assert.ok(pmActionFor(kind as PmActionKind))
  assert.equal(new Set(pmActionKinds).size, pmActionKinds.length, 'no duplicate kind')
})
