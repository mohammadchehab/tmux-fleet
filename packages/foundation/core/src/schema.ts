/**
 * A small schema library, hand-written because the architecture (§1.1) allows
 * no runtime dependency outside `node:` builtins. Types are inferred from the
 * schemas (`Infer`), so a contract is declared once: the JSON a fixture, the
 * store and a provider exchange is checked against the same declaration the
 * TypeScript compiler uses.
 *
 * Design notes:
 * - `decode` never throws. It collects `Issue`s and returns a best-effort
 *   value; the value is only meaningful when no issue was appended. Every
 *   public entry point (`parse`, `safeParse`) enforces that for you.
 * - Decoders ignore object keys that are not in the shape (forward
 *   compatibility: an event written by a newer fleet must still be readable),
 *   and the decoded object is rebuilt from the shape alone. A fixture with a
 *   misspelled key therefore loses that key and fails its round-trip test.
 */

import { err, ok, type Result } from './result.ts'

export interface Issue {
  readonly path: string
  readonly message: string
}

export class SchemaError extends RangeError {
  readonly issues: readonly Issue[]

  constructor(issues: readonly Issue[]) {
    super(issues.map((i) => `${i.path === '' ? '<root>' : i.path}: ${i.message}`).join('; '))
    this.name = 'SchemaError'
    this.issues = issues
  }
}

export type Decoder<T> = (value: unknown, path: string, issues: Issue[]) => T

declare const schemaType: unique symbol

export interface Schema<T> {
  /** For error messages and test names. */
  readonly tag: string
  /** Never throws; see the design note above. */
  decode: Decoder<T>
  /** Phantom member so `Infer` can recover `T`; never read at runtime. */
  readonly [schemaType]?: T
}

export type Infer<S> = S extends Schema<infer T> ? T : never

const make = <T>(tag: string, decode: Decoder<T>): Schema<T> => ({ tag, decode })

const show = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json.length > 80 ? `${json.slice(0, 77)}...` : json
  } catch {
    return String(value)
  }
}

const expected = <T>(issues: Issue[], path: string, tag: string, value: unknown): T => {
  issues.push({ path, message: `expected ${tag}, got ${show(value)}` })
  return value as T
}

export const parse = <T>(schema: Schema<T>, value: unknown): T => {
  const issues: Issue[] = []
  const decoded = schema.decode(value, '', issues)
  if (issues.length > 0) throw new SchemaError(issues)
  return decoded
}

export const safeParse = <T>(schema: Schema<T>, value: unknown): Result<T, SchemaError> => {
  const issues: Issue[] = []
  const decoded = schema.decode(value, '', issues)
  return issues.length > 0 ? err(new SchemaError(issues)) : ok(decoded)
}

// ---------------------------------------------------------------- primitives

export interface StringOptions {
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: RegExp
}

export const string = (options: StringOptions = {}): Schema<string> =>
  make('string', (value, path, issues) => {
    if (typeof value !== 'string') return expected(issues, path, 'string', value)
    if (options.minLength !== undefined && value.length < options.minLength) {
      issues.push({ path, message: `expected at least ${options.minLength} characters, got ${value.length}` })
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      issues.push({ path, message: `expected at most ${options.maxLength} characters, got ${value.length}` })
    }
    if (options.pattern !== undefined && !options.pattern.test(value)) {
      issues.push({ path, message: `expected to match ${String(options.pattern)}, got ${show(value)}` })
    }
    return value
  })

/** A non-empty string; the default for prose fields. */
export const text = (maxLength = 100_000): Schema<string> => string({ minLength: 1, maxLength })

export interface NumberOptions {
  readonly int?: boolean
  readonly min?: number
  readonly max?: number
}

export const number = (options: NumberOptions = {}): Schema<number> =>
  make(options.int === true ? 'integer' : 'number', (value, path, issues) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return expected(issues, path, 'number', value)
    if (options.int === true && !Number.isInteger(value)) {
      issues.push({ path, message: `expected an integer, got ${value}` })
    }
    if (options.min !== undefined && value < options.min) {
      issues.push({ path, message: `expected >= ${options.min}, got ${value}` })
    }
    if (options.max !== undefined && value > options.max) {
      issues.push({ path, message: `expected <= ${options.max}, got ${value}` })
    }
    return value
  })

/** A positive integer: sequence numbers, versions, PR numbers, token counts. */
export const positiveInt = (): Schema<number> => number({ int: true, min: 1 })

/** A non-negative integer: counts and indices where zero is meaningful. */
export const count = (): Schema<number> => number({ int: true, min: 0 })

export const boolean = (): Schema<boolean> =>
  make('boolean', (value, path, issues) =>
    typeof value === 'boolean' ? value : expected(issues, path, 'boolean', value),
  )

export const literal = <const T extends string | number | boolean>(value: T): Schema<T> =>
  make(show(value), (input, path, issues) =>
    input === value ? value : expected(issues, path, show(value), input),
  )

// -------------------------------------------------------------------- shapes

/**
 * Marks an object key as optional. Written as a function returning a schema
 * whose inferred type is `T | undefined`, so `InferShape` can turn it into an
 * optional property.
 */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true
}

export const optional = <T>(schema: Schema<T>): OptionalSchema<T> => ({
  tag: `${schema.tag}?`,
  optional: true,
  decode: (value, path, issues) => (value === undefined ? undefined : schema.decode(value, path, issues)),
})

export const nullable = <T>(schema: Schema<T>): Schema<T | null> =>
  make(`${schema.tag}|null`, (value, path, issues) =>
    value === null ? null : schema.decode(value, path, issues),
  )

export const array = <T>(item: Schema<T>, options: { maxItems?: number } = {}): Schema<readonly T[]> =>
  make(`${item.tag}[]`, (value, path, issues) => {
    if (!Array.isArray(value)) return expected(issues, path, `${item.tag}[]`, value)
    if (options.maxItems !== undefined && value.length > options.maxItems) {
      issues.push({ path, message: `expected at most ${options.maxItems} items, got ${value.length}` })
    }
    return value.map((entry, index) => item.decode(entry, `${path}[${index}]`, issues))
  })

export const record = <T>(valueSchema: Schema<T>): Schema<Readonly<Record<string, T>>> =>
  make(`record<${valueSchema.tag}>`, (value, path, issues) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return expected(issues, path, `record<${valueSchema.tag}>`, value)
    }
    const out: Record<string, T> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = valueSchema.decode(entry, path === '' ? key : `${path}.${key}`, issues)
    }
    return out
  })

export const union = <const Options extends readonly Schema<unknown>[]>(
  options: Options,
): Schema<Infer<Options[number]>> =>
  make(options.map((o) => o.tag).join('|'), (value, path, issues) => {
    let best: Issue[] | undefined
    for (const option of options) {
      const attempt: Issue[] = []
      const decoded = option.decode(value, path, attempt)
      if (attempt.length === 0) return decoded as Infer<Options[number]>
      if (best === undefined || attempt.length < best.length) best = attempt
    }
    // Report the closest miss: it names the field the caller actually got wrong.
    issues.push(...(best ?? [{ path, message: `expected one of ${options.map((o) => o.tag).join(' | ')}` }]))
    return value as Infer<Options[number]>
  })

/** A closed set of string literals, e.g. a state or a kind. */
export const oneOf = <const Values extends readonly string[]>(values: Values): Schema<Values[number]> =>
  union(values.map((value) => literal(value)) as unknown as readonly Schema<Values[number]>[])

export const refine = <T>(
  schema: Schema<T>,
  predicate: (value: T) => boolean,
  message: string,
): Schema<T> =>
  make(`${schema.tag}(${message})`, (value, path, issues) => {
    const before = issues.length
    const decoded = schema.decode(value, path, issues)
    if (issues.length === before && !predicate(decoded)) issues.push({ path, message })
    return decoded
  })

/**
 * A named string type (an id, a repo, a sha). Its failures read as the name,
 * because a caller who passed `nope` as a NotificationKey needs to be told
 * that, not the regex behind it.
 */
export const branded = <T>(
  schema: Schema<string>,
  name: string,
  predicate?: (value: string) => boolean,
): Schema<T> =>
  make(name, (value, path, issues) => {
    const before = issues.length
    const decoded = schema.decode(value, path, issues)
    const innerFailed = issues.length > before
    if (innerFailed) issues.length = before
    if (innerFailed || (predicate !== undefined && !predicate(decoded))) {
      issues.push({ path, message: `expected a valid ${name}, got ${show(decoded)}` })
    }
    return decoded as unknown as T
  })

// ------------------------------------------------------------------- objects

export type Shape = Readonly<Record<string, Schema<unknown>>>

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never
}[keyof S]

type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>

/** `{ a: string; b?: number }` from `{ a: string(), b: optional(number()) }`. */
export type InferShape<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>
}

const isOptional = (schema: Schema<unknown>): schema is OptionalSchema<unknown> =>
  (schema as { optional?: boolean }).optional === true

/**
 * An object schema. Unknown keys are ignored (see the file's design note);
 * every key in the shape is decoded, and optional keys that were absent stay
 * absent so a round-trip reproduces the input exactly.
 */
export const object = <S extends Shape>(shape: S): Schema<InferShape<S>> =>
  make(
    `{${Object.entries(shape)
      .map(([key, schema]) => `${key}: ${schema.tag}`)
      .join(', ')}}`,
    (value, path, issues) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return expected(issues, path, 'object', value)
      }
      const input = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const [key, schema] of Object.entries(shape)) {
        const present = Object.hasOwn(input, key)
        const childPath = path === '' ? key : `${path}.${key}`
        if (!present) {
          if (!isOptional(schema)) {
            issues.push({ path: childPath, message: 'missing required field' })
          }
          continue
        }
        const decoded = schema.decode(input[key], childPath, issues)
        // Optional-and-undefined must not appear in the output: JSON has no
        // undefined, and round-tripping a fixture must be byte-identical.
        if (decoded !== undefined) out[key] = decoded
      }
      return out as InferShape<S>
    },
  )

/**
 * An object of any shape, kept as-is (an env map, provider meta). Values must
 * be JSON-serializable; anything else is a bug in the caller.
 */
export const unknownRecord = (): Schema<Readonly<Record<string, unknown>>> =>
  make('unknown-object', (value, path, issues) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return expected(issues, path, 'object', value)
    }
    return value as Record<string, unknown>
  })
