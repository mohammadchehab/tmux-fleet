/**
 * Golden fixtures for the event vocabulary (architecture §3, §15 phase 0).
 *
 * One JSON file per registered event type under `fixtures/events/`. Each is
 * parsed with its own schema, re-parsed with the union the store uses, and
 * encoded back to the same value — so the fixture is the contract's executable
 * shape, not a sample someone once pasted.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { decodeStrict, parse, SchemaError, type Schema } from '@fleet/foundation-core'
import { EVENT_SCHEMAS, eventSchemaFor, eventTypes, fleetEvent, type FleetEventType } from '../src/index.ts'

const fixturesDir = new URL('./fixtures/events/', import.meta.url)

const fixtureFor = (type: string): unknown =>
  JSON.parse(readFileSync(new URL(`${type}.json`, fixturesDir), 'utf8'))

const invalidDir = new URL('./fixtures/events-invalid/', import.meta.url)

const invalidFor = (type: string): { input: unknown; path: string } =>
  JSON.parse(readFileSync(new URL(`${type}.json`, invalidDir), 'utf8'))

const invalidNames = readdirSync(invalidDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .sort()

const fixtureNames = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .sort()

test('fixtures cover the registry exactly', () => {
  assert.deepEqual(fixtureNames, [...eventTypes].sort(), 'a fixture per registered type, and no fixture for an unregistered one')
})

for (const type of eventTypes) {
  test(`golden: ${type}`, () => {
    const fixture = fixtureFor(type)
    // Indexing the registry by its own key union gives a union of schemas; the
    // fixture decides which variant it is, so the parse is typed as `unknown`.
    const schema: Schema<unknown> = EVENT_SCHEMAS[type]

    const parsed = parse(schema, fixture)
    assert.deepEqual(parsed, fixture, 'decode then encode returns the fixture unchanged')

    assert.equal((parsed as { type: string }).type, type)
    assert.ok(String((parsed as { subject: string }).subject).length > 0, 'an event names its subject')

    // The envelope's `type` decides the variant: the union must accept the fixture too.
    const viaUnion = parse(fleetEvent(), fixture) as { type: string }
    assert.equal(viaUnion.type, type)

    // Decoding a decoded value is stable: no field is dropped or added by encoding.
    assert.deepEqual(parse(schema, parsed), parsed)
  })
}

test('eventSchemaFor resolves a registered type and refuses an unregistered one', () => {
  assert.ok(eventSchemaFor('work.assigned'))
  assert.equal(eventSchemaFor('work.invented'), undefined)
  assert.equal(eventSchemaFor('toString'), undefined, 'a prototype key is not a registered type')
})

test('the union rejects a fixture whose type was relabelled', () => {
  const fixture = fixtureFor('work.assigned') as Record<string, unknown>
  const relabelled = { ...fixture, type: 'work.merged' }
  assert.throws(() => parse(fleetEvent(), relabelled), SchemaError)
})

test('a schema rejects a fixture with a broken field, so the round-trip is not vacuous', () => {
  const fixture = fixtureFor('peer.registered') as { data: Record<string, unknown> }
  assert.throws(() => parse(EVENT_SCHEMAS['peer.registered'], { ...fixture, seq: 0 }), SchemaError, 'seq is 1-based')
  assert.throws(
    () => parse(EVENT_SCHEMAS['peer.registered'], { ...fixture, data: { ...fixture.data, peerId: 'Engineer_1' } }),
    SchemaError,
    'a peer id is lowercase and hyphenated',
  )
})

test('an unknown key on a fixture is tolerated, so a newer writer cannot break an older reader', () => {
  const fixture = fixtureFor('work.ready') as Record<string, unknown>
  const extended = { ...fixture, futureField: { anything: true }, data: { ...(fixture.data as object), alsoFuture: 1 } }
  assert.deepEqual(parse(EVENT_SCHEMAS['work.ready'], extended), fixture)
})

test('eventTypes has no duplicate and is the registry keys, untouched', () => {
  assert.equal(new Set(eventTypes).size, eventTypes.length)
  assert.deepEqual([...eventTypes], Object.keys(EVENT_SCHEMAS) as FleetEventType[])
})

/**
 * The other half of the corpus: one input per event type that must be refused,
 * and the exact path the refusal must name. A schema that starts accepting a
 * value it used to refuse — a widened enum, an optional that became required
 * nowhere, a brand that lost its pattern — fails here even though every golden
 * fixture still round-trips.
 *
 * The corpus is generated from the goldens by `generate-invalid.ts` (one
 * mutation per file), so regenerating it is how an intentional widening is
 * recorded rather than silently absorbed.
 */
test('invalid fixtures cover the registry exactly', () => {
  assert.deepEqual(invalidNames, [...eventTypes].sort(), 'one refused input per registered type')
})

for (const type of eventTypes) {
  test(`refused: ${type}`, () => {
    const { input, path } = invalidFor(type)
    assert.notDeepEqual(input, fixtureFor(type), 'the invalid input is a mutation of the golden one')

    const result = decodeStrict(EVENT_SCHEMAS[type] as Schema<unknown>, input)
    assert.equal(result.ok, false, 'the store refuses it at the append boundary')
    if (result.ok) return
    assert.equal(result.error.issues.length, 1, `one mutation, one issue: ${result.error.message}`)
    assert.equal(result.error.issues[0].path, path, 'the refusal names the field that was mutated')
  })
}

test('an append with a misspelt optional field is refused, not silently stripped', () => {
  // The tolerant reader drops `judgeModell` and keeps the event; the append
  // boundary must not, or a producer's typo becomes data loss.
  const fixture = fixtureFor('judge.answered') as { data: Record<string, unknown> }
  const misspelt = { ...fixture, data: { ...fixture.data, judgeModell: 'claude-sonnet-5-5' } }

  assert.deepEqual(parse(EVENT_SCHEMAS['judge.answered'], misspelt), fixture, 'a reader tolerates it')

  const result = decodeStrict(EVENT_SCHEMAS['judge.answered'] as Schema<unknown>, misspelt)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(
    result.error.issues.map((issue) => issue.path),
    ['data.judgeModell'],
  )
})
