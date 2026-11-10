/**
 * A small schema library, hand-written because the architecture (§1.1) allows
 * no runtime dependency outside `node:` builtins. Types are inferred from the
 * schemas (`Infer`), so a contract is declared once: the JSON a fixture, the
 * store and a provider exchange is checked against the same declaration the
 * TypeScript compiler uses.
 *
 * Decoding has two modes:
 *
 * - **tolerant** (`parse`, `decode`) is for *reading*. Object keys that are not
 *   in the shape are ignored, so an event written by a newer fleet is still
 *   readable by an older one and a rollback does not lose the log.
 * - **strict** (`parseStrict`, `decodeStrict`) is for *writing*. An unknown key
 *   is an error, because at a producer boundary an unknown key is a misspelt
 *   optional field, and tolerating it loses data silently. `Store.append` and
 *   every other write boundary use this one.
 *
 * `decode` never throws in either mode: it collects `Issue`s and returns a
 * best-effort value that is only meaningful when no issue was appended. The
 * public entry points enforce that for you.
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

/** Whether unknown object keys are refused. See the file's design note. */
export interface Mode {
  readonly strict: boolean
}

export const tolerant: Mode = { strict: false }
export const strict: Mode = { strict: true }

export type Decoder<T> = (value: unknown, path: string, issues: Issue[], mode: Mode) => T

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

const decodeWith = <T>(schema: Schema<T>, value: unknown, mode: Mode): Result<T, SchemaError> => {
  const issues: Issue[] = []
  const decoded = schema.decode(value, '', issues, mode)
  return issues.length > 0 ? err(new SchemaError(issues)) : ok(decoded)
}

/** Tolerant: unknown keys are ignored. For reading. */
export const decode = <T>(schema: Schema<T>, value: unknown): Result<T, SchemaError> =>
  decodeWith(schema, value, tolerant)

/** Strict: an unknown key is an issue. For a write boundary. */
export const decodeStrict = <T>(schema: Schema<T>, value: unknown): Result<T, SchemaError> =>
  decodeWith(schema, value, strict)

/** Tolerant: unknown keys are ignored. For reading. */
export const parse = <T>(schema: Schema<T>, value: unknown): T => {
  const result = decode(schema, value)
  if (!result.ok) throw result.error
  return result.value
}

/** Strict: an unknown key is a `SchemaError`. For a write boundary. */
export const parseStrict = <T>(schema: Schema<T>, value: unknown): T => {
  const result = decodeStrict(schema, value)
  if (!result.ok) throw result.error
  return result.value
}

export const safeParse = <T>(schema: Schema<T>, value: unknown): Result<T, SchemaError> => decode(schema, value)

export const safeParseStrict = <T>(schema: Schema<T>, value: unknown): Result<T, SchemaError> =>
  decodeStrict(schema, value)

// --------------------------------------------------------- compile-time checks

/**
 * `Equal` that ignores `readonly`, and flattens the intersections `InferShape`
 * produces. Two spellings of one shape compare equal; two different shapes do
 * not, and an extra optional field is a difference (unlike plain assignability).
 */
export type Normalize<T> = T extends readonly (infer U)[]
  ? Normalize<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Normalize<T[K]> }
    : T

export type Equal<A, B> =
  (<T>() => T extends Normalize<A> ? 1 : 2) extends <T>() => T extends Normalize<B> ? 1 : 2 ? true : false

declare const drift: unique symbol

/** What a mismatched `objectAs` argument compiles to; names both sides. */
export type Drift<Got, Want> = { readonly [drift]: { readonly got: Got; readonly want: Want } }

/**
 * `object()` with the interface it must match named: the argument is rejected
 * unless `InferShape<S>` equals `Iface` exactly. This replaces `as Schema<X>`,
 * which silences precisely the drift worth catching — a schema that gained a
 * field, lost one, or changed a type without the interface moving.
 *
 *     export const turn = (): Schema<Turn> => objectAs<Turn>()({ text: text(), kind: oneOf(turnKinds) })
 */
export const objectAs =
  <Iface>() =>
  <S extends Shape>(
    shape: S & (Equal<InferShape<S>, Iface> extends true ? unknown : Drift<InferShape<S>, Iface>),
  ): Schema<Iface> =>
    object(shape) as unknown as Schema<Iface>

/**
 * A union of object schemas with its type named, on the same terms as
 * `objectAs`: the argument is rejected unless the union infers to exactly
 * `Iface`.
 */
export const unionAs =
  <Iface>() =>
  <const Options extends readonly Schema<unknown>[]>(
    options: Options & (Equal<Infer<Options[number]>, Iface> extends true ? unknown : Drift<Infer<Options[number]>, Iface>),
  ): Schema<Iface> =>
    union(options) as unknown as Schema<Iface>

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
  decode: (value, path, issues, mode) => (value === undefined ? undefined : schema.decode(value, path, issues, mode)),
})

export const nullable = <T>(schema: Schema<T>): Schema<T | null> =>
  make(`${schema.tag}|null`, (value, path, issues, mode) =>
    value === null ? null : schema.decode(value, path, issues, mode),
  )

export const array = <T>(item: Schema<T>, options: { maxItems?: number } = {}): Schema<readonly T[]> =>
  make(`${item.tag}[]`, (value, path, issues, mode) => {
    if (!Array.isArray(value)) return expected(issues, path, `${item.tag}[]`, value)
    if (options.maxItems !== undefined && value.length > options.maxItems) {
      issues.push({ path, message: `expected at most ${options.maxItems} items, got ${value.length}` })
    }
    return value.map((entry, index) => item.decode(entry, `${path}[${index}]`, issues, mode))
  })

/** An open map: every key is data, so strict mode has nothing to refuse. */
export const record = <T>(valueSchema: Schema<T>): Schema<Readonly<Record<string, T>>> =>
  make(`record<${valueSchema.tag}>`, (value, path, issues, mode) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return expected(issues, path, `record<${valueSchema.tag}>`, value)
    }
    const out: Record<string, T> = {}
    for (const [key, entry] of Object.entries(value)) {
      const decoded = valueSchema.decode(entry, path === '' ? key : `${path}.${key}`, issues, mode)
      // Defined, not assigned: `out['__proto__'] = …` runs the prototype setter, which
      // drops a primitive and replaces the prototype with an object. The result is
      // still a plain object, so no caller sees a different shape (TASK-49).
      Object.defineProperty(out, key, { value: decoded, writable: true, enumerable: true, configurable: true })
    }
    return out
  })

export const union = <const Options extends readonly Schema<unknown>[]>(
  options: Options,
): Schema<Infer<Options[number]>> =>
  make(options.map((o) => o.tag).join('|'), (value, path, issues, mode) => {
    let best: Issue[] | undefined
    for (const option of options) {
      const attempt: Issue[] = []
      const decoded = option.decode(value, path, attempt, mode)
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

/** A refined schema, keeping the schema it wraps so tooling can walk through it. */
export interface RefinedSchema<T> extends Schema<T> {
  readonly inner: Schema<T>
}

export const refine = <T>(
  schema: Schema<T>,
  predicate: (value: T) => boolean,
  message: string,
): RefinedSchema<T> => ({
  ...make(`${schema.tag}(${message})`, (value, path, issues, mode) => {
    const before = issues.length
    const decoded = schema.decode(value, path, issues, mode)
    if (issues.length === before && !predicate(decoded)) issues.push({ path, message })
    return decoded
  }),
  inner: schema,
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
  make(name, (value, path, issues, mode) => {
    const before = issues.length
    const decoded = schema.decode(value, path, issues, mode)
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

/** An object schema that keeps its shape, so tooling can walk it. */
export interface ObjectSchema<S extends Shape> extends Schema<InferShape<S>> {
  readonly shape: S
}

/**
 * An object schema. Unknown keys are ignored in tolerant mode and reported in
 * strict mode (see the file's design note); every key in the shape is decoded,
 * and optional keys that were absent stay absent so a round-trip reproduces the
 * input exactly.
 */
export const object = <S extends Shape>(shape: S): ObjectSchema<S> => {
  const schema: ObjectSchema<S> = {
    ...make<InferShape<S>>(
      `{${Object.entries(shape)
        .map(([key, entry]) => `${key}: ${entry.tag}`)
        .join(', ')}}`,
      (value, path, issues, mode) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return expected(issues, path, 'object', value)
        }
        const input = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        if (mode.strict) {
          for (const key of Object.keys(input)) {
            if (!Object.hasOwn(shape, key)) {
              issues.push({ path: path === '' ? key : `${path}.${key}`, message: 'unknown field' })
            }
          }
        }
        for (const [key, entry] of Object.entries(shape)) {
          const present = Object.hasOwn(input, key)
          const childPath = path === '' ? key : `${path}.${key}`
          if (!present) {
            if (!isOptional(entry)) {
              issues.push({ path: childPath, message: 'missing required field' })
            }
            continue
          }
          const decoded = entry.decode(input[key], childPath, issues, mode)
          // Optional-and-undefined must not appear in the output: JSON has no
          // undefined, and round-tripping a fixture must be byte-identical.
          if (decoded !== undefined) out[key] = decoded
        }
        return out as InferShape<S>
      },
    ),
    shape,
  }
  return schema
}

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
