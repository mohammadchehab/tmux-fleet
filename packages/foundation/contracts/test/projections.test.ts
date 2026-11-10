/**
 * Golden fixtures for the projections (architecture §3, §15 phase 0). A
 * projection is what a client reads; one fixture per registered projection
 * type, round-tripped through its schema the same way events are.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { parse, SchemaError, type Schema } from '@fleet/foundation-core'
import { PROJECTION_SCHEMAS, projectionNames, projectionSchema, type ProjectionName } from '../src/index.ts'

const fixturesDir = new URL('./fixtures/projections/', import.meta.url)

const fixtureFor = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`${name}.json`, fixturesDir), 'utf8'))

const fixtureNames = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .sort()

test('fixtures cover the projections exactly', () => {
  assert.deepEqual(fixtureNames, [...projectionNames].sort())
})

for (const name of projectionNames) {
  test(`golden: ${name}`, () => {
    const fixture = fixtureFor(name)
    const schema: Schema<unknown> = PROJECTION_SCHEMAS[name]

    const parsed = parse(schema, fixture)
    assert.deepEqual(parsed, fixture, 'decode then encode returns the fixture unchanged')
    assert.deepEqual(parse(schema, parsed), parsed, 'a second decode changes nothing')
  })
}

test('projectionSchema resolves by name and refuses an unknown one', () => {
  assert.ok(projectionSchema('work'))
  assert.equal(projectionSchema('works'), undefined)
  assert.equal(projectionSchema('constructor'), undefined)
})

test('a projection schema rejects a malformed row', () => {
  const fixture = fixtureFor('work') as Record<string, unknown>
  const schema = PROJECTION_SCHEMAS.work
  assert.throws(
    () => parse(schema, { ...fixture, state: 'invented' }),
    SchemaError,
    'work.state is one of the declared states',
  )
  assert.throws(() => parse(schema, { ...fixture, dependsOn: [1, 2] }), SchemaError, 'dependsOn holds ids, not numbers')
})

test('projectionNames is exactly the registry, in declaration order', () => {
  assert.deepEqual([...projectionNames], Object.keys(PROJECTION_SCHEMAS) as ProjectionName[])
})
