/**
 * Generator for `test/fixtures/events-invalid/` and
 * `test/fixtures/provider-events-invalid/`.
 *
 * For each registered event type it takes the golden fixture and applies one
 * mutation to a required field of `data`, then checks the mutated value really
 * does fail decoding with the path it expects. The result is a corpus a reader
 * can inspect: `{ input, path }`, where `path` is the issue the schema must
 * report.
 *
 * The corpus is a function of the golden fixtures alone — see `offsetOf` — so
 * `generate-invalid.test.ts` can hold it to two things: generating twice gives
 * the same bytes, and the committed files are those bytes.
 *
 * Run with: node --experimental-strip-types generate-invalid.ts
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { EVENT_SCHEMAS, eventTypes, providerEvent } from './src/index.ts'
import type { ObjectSchema, Schema } from '@fleet/foundation-core'
import { decodeStrict } from '@fleet/foundation-core'

const packageDir = new URL('./', import.meta.url)
const eventsDir = new URL('./test/fixtures/events/', packageDir)
const providerEventsDir = new URL('./test/fixtures/provider-events/', packageDir)

/** One file the generator would write: its path from this package, and its exact bytes. */
export interface GeneratedFixture {
  /** Path from the contracts package directory, POSIX separators, e.g. `test/fixtures/events-invalid/judge.scored.json`. */
  readonly path: string
  /** The file's contents, including the trailing newline. */
  readonly contents: string
}

const isOptional = (schema: Schema<unknown>): boolean => (schema as { optional?: boolean }).optional === true

/**
 * A record lookup this generator is sure about: every key it reads came from
 * `Object.keys` of the same record, so a miss is a bug in here and not an input
 * to handle. `noUncheckedIndexedAccess` makes that certainty explicit instead of
 * letting the code assume it silently.
 */
const field = <T>(record: Readonly<Record<string, T>>, key: string): T => {
  const value = record[key]
  if (value === undefined) throw new Error(`generate-invalid: no '${key}' in the fixture shape`)
  return value
}

/**
 * Where in `keys` this fixture's mutation starts, so the corpus covers every
 * position of `data` rather than only the first id of every event.
 *
 * The offset comes from the fixture's own name, not from its index in the
 * registry. Index-rotation made the corpus a function of *where* a type sits:
 * inserting an unrelated type shifted every type after it, and the corpus on
 * disk drifted from what the generator produces because the type that shifted
 * it was never followed by a regeneration. A name is insertion-proof, and
 * spreads different types over different positions just as well.
 */
const offsetOf = (name: string): number => {
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return hash
}

/** Rotate `values` by `offset`, so a corpus covers every position and not only the first. */
const rotate = <T>(values: readonly T[], offset: number): T[] => {
  if (values.length === 0) return []
  const start = offset % values.length
  return [...values.slice(start), ...values.slice(0, start)]
}

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

const firstFailurePath = (type: string, input: unknown): string | undefined => {
  const result = decodeStrict((EVENT_SCHEMAS as Record<string, Schema<unknown>>)[type] as Schema<unknown>, input)
  return result.ok ? undefined : result.error.issues[0]?.path
}

const eventFixtures = (): GeneratedFixture[] => {
  const generated: GeneratedFixture[] = []

  for (const name of eventTypes) {
    const fixture = JSON.parse(readFileSync(new URL(`${name}.json`, eventsDir), 'utf8')) as {
      data: Record<string, unknown>
    }
    const shape = dataShapeOf(name).shape as Record<string, Schema<unknown>>
    const keys = Object.keys(shape).filter((key) => !isOptional(field(shape, key)))

    // Rotate the field under test, so the corpus covers every position of `data`
    // rather than only the first id of every event.
    const rotated = rotate(keys, offsetOf(name))

    let written: { input: unknown; path: string } | undefined
    for (const key of rotated) {
      const tag = field(shape, key).tag
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
        if (firstFailurePath(name, mutated) === `data.${key}`) {
          written = { input: mutated, path: `data.${key}` }
          break
        }
      }
      if (written) break

      // Last resort: drop the field, so the failure names the missing key.
      const mutated = structuredClone(fixture)
      delete mutated.data[key]
      if (firstFailurePath(name, mutated) === `data.${key}`) {
        written = { input: mutated, path: `data.${key}` }
        break
      }
    }
    if (!written) throw new Error(`no mutation produces a single issue for ${name}`)
    generated.push({
      path: `test/fixtures/events-invalid/${name}.json`,
      contents: `${JSON.stringify(written, null, 2)}\n`,
    })
  }

  return generated
}

/**
 * The provider stream crosses the process boundary too (§4), so it gets the
 * same treatment: one mutation per event `type`, with the path the union must
 * report. Provider events are flat, so the path is a bare key.
 */
const providerEventFixtures = (): GeneratedFixture[] => {
  const generated: GeneratedFixture[] = []
  const names = readdirSync(providerEventsDir)
    .filter((name) => name.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort()

  for (const name of names) {
    const fixture = JSON.parse(readFileSync(new URL(`${name}.json`, providerEventsDir), 'utf8')) as Record<
      string,
      unknown
    >
    const keys = Object.keys(fixture).filter((key) => key !== 'type')
    const rotated = rotate(keys, offsetOf(name))

    let written: { input: unknown; path: string } | undefined
    for (const key of rotated) {
      const current = fixture[key]
      const candidates: unknown[] = []
      if (typeof current === 'string') candidates.push(42, 'not-a-valid-value')
      else if (typeof current === 'number') candidates.push('not-a-number')
      else if (Array.isArray(current)) candidates.push([])
      for (const replacement of candidates) {
        const mutated = structuredClone(fixture)
        mutated[key] = replacement
        const result = decodeStrict(providerEvent(), mutated)
        if (!result.ok && result.error.issues.length === 1 && result.error.issues[0]?.path === key) {
          written = { input: mutated, path: key }
          break
        }
      }
      if (written) break

      const mutated = structuredClone(fixture)
      delete mutated[key]
      const result = decodeStrict(providerEvent(), mutated)
      if (!result.ok && result.error.issues.length === 1 && result.error.issues[0]?.path === key) {
        written = { input: mutated, path: key }
        break
      }
    }
    if (!written) throw new Error(`no mutation produces a single issue for provider event ${name}`)
    generated.push({
      path: `test/fixtures/provider-events-invalid/${name}.json`,
      contents: `${JSON.stringify(written, null, 2)}\n`,
    })
  }

  return generated
}

/** Every file the corpus is made of, in a stable order, without touching the tree. */
export const buildInvalidCorpus = (): readonly GeneratedFixture[] => [
  ...eventFixtures(),
  ...providerEventFixtures(),
]

/** Write `buildInvalidCorpus()` to the tree. */
export const writeInvalidCorpus = (): readonly GeneratedFixture[] => {
  const corpus = buildInvalidCorpus()
  for (const { path, contents } of corpus) {
    const url = new URL(path, packageDir)
    mkdirSync(new URL('.', url), { recursive: true })
    writeFileSync(url, contents)
  }
  return corpus
}

if (import.meta.main) {
  const corpus = writeInvalidCorpus()
  const events = corpus.filter((fixture) => fixture.path.includes('/events-invalid/')).length
  console.log(`wrote ${events} invalid event fixtures, ${corpus.length - events} invalid provider-event fixtures`)
}
