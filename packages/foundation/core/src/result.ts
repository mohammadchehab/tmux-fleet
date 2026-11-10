/**
 * A total value for "worked or failed", so fallible code needs no exceptions
 * for expected outcomes. `Result` is used by `safeParse` and by every port.
 */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok

export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok

/** Unwrap or throw. Use at boundaries where a failure is a programming error. */
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value
  throw r.error instanceof Error ? r.error : new Error(String(r.error))
}

export const mapResult = <T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r

export const flatMapResult = <T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> =>
  r.ok ? f(r.value) : r
