import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  array,
  literal,
  object,
  oneOf,
  optional,
  parse,
  record,
  refine,
  safeParse,
  SchemaError,
  string,
  union,
} from '../src/schema.ts'

const point = object({ x: refine(string(), (v) => v.length > 0, 'non-empty'), y: optional(literal(2)) })

describe('schema combinators', () => {
  test('object decodes, and an absent optional key stays absent rather than becoming undefined', () => {
    assert.deepEqual(parse(point, { x: 'a' }), { x: 'a' })
    assert.deepEqual(parse(point, { x: 'a', y: 2 }), { x: 'a', y: 2 })
  })

  test('unknown keys are ignored, so a newer writer stays readable', () => {
    assert.deepEqual(parse(point, { x: 'a', fromTheFuture: true }), { x: 'a' })
  })

  test('a missing required field fails with a path that names it', () => {
    const result = safeParse(point, { y: 2 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.error instanceof SchemaError)
    assert.deepEqual(result.error.issues.map((i) => i.path), ['x'])
  })

  test('a malformed field fails with both the field and its parent in the path', () => {
    const nested = object({ outer: object({ name: string() }) })
    assert.throws(() => parse(nested, { outer: { name: 7 } }), /outer\.name: expected string, got 7/)
  })

  test('refine keeps its own message instead of the inner one', () => {
    assert.throws(() => parse(point, { x: '' }), /x: non-empty/)
  })

  test('union reports the closest variant, not a generic message', () => {
    const shape = union([
      object({ kind: literal('a'), n: string() }),
      object({ kind: literal('b'), n: string(), m: string() }),
    ])
    const result = safeParse(shape, { kind: 'a', n: 1 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.deepEqual(result.error.issues.map((i) => i.path), ['n'])
  })

  test('oneOf accepts a member and rejects the rest', () => {
    assert.equal(parse(oneOf(['a', 'b']), 'b'), 'b')
    assert.throws(() => parse(oneOf(['a', 'b']), 'c'), /expected "a"|"b"/)
  })

  test('array, record and array paths report the index', () => {
    assert.deepEqual(parse(array(string()), ['a']), ['a'])
    assert.deepEqual(parse(record(string()), { k: 'v' }), { k: 'v' })
    assert.throws(() => parse(array(string()), ['a', 1]), /\[1\]: expected string/)
  })

  test('parse throws once with every issue collected', () => {
    const shape = object({ a: string(), b: string() })
    assert.throws(
      () => parse(shape, {}),
      (error: unknown) => {
        assert.ok(error instanceof SchemaError)
        assert.equal(error.issues.length, 2)
        return true
      },
    )
  })
})
