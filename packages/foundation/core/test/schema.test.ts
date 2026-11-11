import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  array,
  literal,
  object,
  oneOf,
  optional,
  parse,
  parseStrict,
  record,
  refine,
  safeParse,
  safeParseStrict,
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

  test('a record keeps a __proto__ key as data and its prototype stays Object.prototype (TASK-49)', () => {
    // JSON.parse makes `__proto__` an own key; `out[key] = …` on a plain object
    // would hit the prototype setter instead: a primitive value is dropped, an
    // object value replaces the prototype.
    const primitive = parse(record(string()), JSON.parse('{"__proto__":"x","a":"b"}')) as Record<string, string>
    assert.equal(Object.hasOwn(primitive, '__proto__'), true, 'the key is not dropped')
    assert.equal(Object.getOwnPropertyDescriptor(primitive, '__proto__')?.value, 'x')
    assert.equal(primitive['a'], 'b')

    const nested = parse(record(object({ polluted: string() })), JSON.parse('{"__proto__":{"polluted":"yes"}}'))
    assert.equal(Object.getPrototypeOf(nested), Object.prototype, 'the prototype is not replaced')
    assert.equal(Object.hasOwn(nested, '__proto__'), true)
    assert.equal((nested as { polluted?: string }).polluted, undefined, 'nothing is inherited from the key')
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

describe('write boundaries are strict, reads are tolerant', () => {
  test('a tolerant parse drops an unknown key, a strict one names it', () => {
    const input = { x: 'a', typo: 'lost silently' }
    assert.deepEqual(parse(point, input), { x: 'a' }, 'a reader tolerates a newer writer')

    const result = safeParseStrict(point, input)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.deepEqual(result.error.issues.map((i) => i.path), ['typo'])
  })

  test('a misspelt optional field is caught before it reaches the store', () => {
    // The case the mode exists for: `y` is optional, so a typo would otherwise
    // change the value silently instead of failing.
    assert.deepEqual(parse(point, { x: 'a', Y: 2 }), { x: 'a' })
    assert.throws(() => parseStrict(point, { x: 'a', Y: 2 }), /Y: unknown field/)
  })

  test('strict mode reaches nested objects and array items, not just the root', () => {
    const nested = object({ outer: object({ name: string() }), items: array(object({ id: string() })) })
    assert.throws(() => parseStrict(nested, { outer: { name: 'n', extra: 1 }, items: [] }), /outer\.extra/)
    assert.throws(() => parseStrict(nested, { outer: { name: 'n' }, items: [{ id: 'i', extra: 1 }] }), /items\[0\]\.extra/)
  })

  test('an open map is data all the way down, so strict mode has nothing to refuse', () => {
    const env = record(string())
    assert.deepEqual(parseStrict(env, { PATH: '/bin', HOME: '/root' }), { PATH: '/bin', HOME: '/root' })
  })

  test('strict mode still accepts a value the shape declares in full', () => {
    assert.deepEqual(parseStrict(point, { x: 'a', y: 2 }), { x: 'a', y: 2 })
  })
})
