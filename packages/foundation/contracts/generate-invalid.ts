/**
 * One-off generator for `test/fixtures/events-invalid/`. Not part of the suite.
 *
 * For each registered event type it takes the golden fixture and applies one
 * mutation to a required field of `data`, then checks the mutated value really
 * does fail decoding with the path it expects. The result is a corpus a reader
 * can inspect: `{ input, path }`, where `path` is the issue the schema must
 * report.
 *
 * Run with: node --experimental-strip-types generate-invalid.ts
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { EVENT_SCHEMAS, eventTypes } from './src/index.ts'
import type { ObjectSchema, Schema } from '@fleet/foundation-core'
import { decodeStrict } from '@fleet/foundation-core'

const eventsDir = new URL('./test/fixtures/events/', import.meta.url)
const outDir = new URL('./test/fixtures/events-invalid/', import.meta.url)
mkdirSync(outDir, { recursive: true })

const isOptional = (schema: Schema<unknown>): boolean => (schema as { optional?: boolean }).optional === true

const dataShapeOf = (type: string): ObjectSchema<never> => {
  const schema = EVENT_SCHEMAS[type as keyof typeof EVENT_SCHEMAS] as unknown as ObjectSchema<never>
  const data = (schema.shape as Record<string, Schema<unknown>>).data as unknown as {
    shape?: Record<string, Schema<unknown>>
    inner?: { shape: Record<string, Schema<unknown>> }
  }
  // A refined object (the judge events check that `kind` and `input.kind` agree)
  // keeps its inner schema, so the mutation walks through to the shape.
  const shape = data.shape ?? data.inner?.shape
  return { shape } as unknown as ObjectSchema<never>
}

const firstFailurePath = (input: unknown): string | undefined => {
  const result = decodeStrict((EVENT_SCHEMAS as Record<string, Schema<unknown>>)[type] as Schema<unknown>, input)
  return result.ok ? undefined : result.error.issues[0]?.path
}

let type = ''
const generated: string[] = []

for (const name of eventTypes) {
  type = name
  const fixture = JSON.parse(readFileSync(new URL(`${name}.json`, eventsDir), 'utf8')) as {
    data: Record<string, unknown>
  }
  const shape = dataShapeOf(name).shape as Record<string, Schema<unknown>>
  const keys = Object.keys(shape).filter((key) => !isOptional(shape[key]))

  // Rotate the field under test, so the corpus covers every position of `data`
  // rather than only the first id of every event.
  const offset = eventTypes.indexOf(name)
  const rotated = keys.map((_, i) => keys[(i + offset) % keys.length])

  let written: { input: unknown; path: string } | undefined
  for (const key of rotated) {
    const tag = shape[key].tag
    const current = fixture.data[key]
    const candidates: unknown[] = []
    // A closed set: a value outside it is refused by the union of literals.
    if (tag.includes('|') && typeof current === 'string') candidates.push('not-a-valid-value')
    // A number where the shape wants one, and the reverse: the commonest slip.
    if (tag === 'integer' || tag === 'number') candidates.push('not-a-number')
    else if (typeof current === 'string') candidates.push(42)
    else if (typeof current === 'number') candidates.push('not-a-number')
    else if (typeof current === 'boolean') candidates.push('not-a-boolean')

    for (const replacement of candidates) {
      const mutated = structuredClone(fixture)
      mutated.data[key] = replacement
      if (firstFailurePath(mutated) === `data.${key}`) {
        written = { input: mutated, path: `data.${key}` }
        break
      }
    }
    if (written) break

    // Last resort: drop the field, so the failure names the missing key.
    const mutated = structuredClone(fixture)
    delete mutated.data[key]
    if (firstFailurePath(mutated) === `data.${key}`) {
      written = { input: mutated, path: `data.${key}` }
      break
    }
  }
  if (!written) throw new Error(`no mutation produces a single issue for ${name}`)
  writeFileSync(new URL(`${name}.json`, outDir), `${JSON.stringify(written, null, 2)}\n`)
  generated.push(name)
}

console.log(`wrote ${generated.length} invalid fixtures`)
console.log(readdirSync(outDir).length)
