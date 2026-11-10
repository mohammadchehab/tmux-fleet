/**
 * One error type for the whole fleet (architecture §3, §13). A `code` is a
 * closed set so callers switch on it instead of matching message text, and so
 * a failure can be written to the store as a typed event.
 */

export const fleetErrorCodes = [
  /** The caller sent something that does not satisfy a schema. */
  'invalid_input',
  /** The entity named does not exist in the store. */
  'not_found',
  /** The entity exists but its state forbids the action (a version clash, a stale brief). */
  'conflict',
  /** A provider session failed, died, or could not be resumed. */
  'provider_failed',
  /** A provider cannot do what was asked; `Provider.capabilities` said so. */
  'unsupported',
  /** The event store or a projection failed. */
  'store_failed',
  /** A session came up in a permission mode other than the one in its SessionSpec (§4, §13). */
  'permission_mode_mismatch',
  /** A session came up on a model or endpoint other than the one in its SessionSpec (§4, §13). */
  'config_mismatch',
  /** An external call (gh, git, a scanner) failed or timed out. */
  'external_failed',
  /**
   * A merge was refused because the head is no longer the sha it was pinned to
   * (§10). Distinct from `external_failed` on purpose: the call worked, and the
   * answer is a fact about the PR — the PM's action was decided on inputs that
   * have since moved — so it is not something a blind retry should paper over.
   */
  'head_moved',
  /** The operation did not finish in time. */
  'timeout',
  /** A bug: the code reached a state it does not model. */
  'internal',
] as const

export type FleetErrorCode = (typeof fleetErrorCodes)[number]

export const isFleetErrorCode = (v: unknown): v is FleetErrorCode =>
  typeof v === 'string' && (fleetErrorCodes as readonly string[]).includes(v)

export type FleetErrorDetails = Readonly<Record<string, unknown>>

export class FleetError extends Error {
  readonly code: FleetErrorCode
  readonly details: FleetErrorDetails | undefined

  constructor(code: FleetErrorCode, message: string, options?: { details?: FleetErrorDetails; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'FleetError'
    this.code = code
    this.details = options?.details
  }
}

export const fleetError = (
  code: FleetErrorCode,
  message: string,
  options?: { details?: FleetErrorDetails; cause?: unknown },
): FleetError => new FleetError(code, message, options)

/** Narrow any thrown value to a FleetError without losing the original. */
export const toFleetError = (thrown: unknown, fallback: FleetErrorCode = 'internal'): FleetError => {
  if (thrown instanceof FleetError) return thrown
  if (thrown instanceof Error) return new FleetError(fallback, thrown.message, { cause: thrown })
  return new FleetError(fallback, String(thrown), { cause: thrown })
}
