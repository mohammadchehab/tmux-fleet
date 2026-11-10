/**
 * What the supervisor writes, typed by the contract rather than by this package
 * (§3).
 *
 * The registry already owns every `type` → `data` schema, so these are
 * `Extract`s of `AppendEvent`: a field the registry does not have, a missing
 * one, or a renamed one is a compile error here, instead of a record the store
 * refuses at runtime or a projection reads as empty. So the daemon appends what
 * the supervisor produces without a mapper in between — there is no second
 * shape to drift.
 */

import {
  decodeStrict,
  fleetError,
  sessionId as sessionIdSchema,
  type SessionId,
} from '@fleet/foundation-core'
import type { AppendEvent } from '@fleet/foundation-contracts'
import type { SessionHandle } from '@fleet/runtime-provider-sdk'

/** A §8 purge step: the trigger, the handoff, and the fresh session in place. */
export type PurgeRecord = Extract<
  AppendEvent,
  { type: 'purge.started' | 'purge.saved' | 'purge.degraded' | 'purge.completed' }
>

/**
 * Everything one session's stream produces: its states, its compactions, its
 * end, its purges, and the one fault this loop refuses to route around (§8).
 *
 * `provider.errored` is here for the last of those: the supervisor's own
 * invariant violation has no event of its own, and inventing one would ripple
 * through every projection and replay fixture for a record a reader already
 * knows how to read — `code: 'invariant'` is what makes it distinguishable, and
 * the store's failure notification is what makes somebody see it.
 */
export type SessionRecord =
  | PurgeRecord
  | Extract<AppendEvent, { type: 'peer.state_changed' | 'peer.compacted' | 'session.ended' | 'provider.errored' }>

/**
 * The provider hands back a bare `string`; the store's events carry a
 * `SessionId`. Decoding instead of casting puts the failure at the boundary
 * that produced it: a provider that invents its own refs is a bug here, now,
 * not an event no reader can join on later.
 */
export const sessionIdOf = (handle: SessionHandle): SessionId => {
  const decoded = decodeStrict(sessionIdSchema(), handle.sessionId)
  if (!decoded.ok) {
    throw fleetError(
      'internal',
      `provider ${handle.providerId} returned ${JSON.stringify(handle.sessionId)}, which is not a session id`,
      { details: { peerId: handle.peerId }, cause: decoded.error },
    )
  }
  return decoded.value
}
