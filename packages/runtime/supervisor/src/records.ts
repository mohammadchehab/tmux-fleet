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
import { permissionMode as permissionModeSchema, type AppendEvent, type PermissionMode } from '@fleet/foundation-contracts'
import type { SessionHandle } from '@fleet/runtime-provider-sdk'

/** A §8 purge step: the trigger, the handoff, and the fresh session in place. */
export type PurgeRecord = Extract<
  AppendEvent,
  { type: 'purge.started' | 'purge.saved' | 'purge.degraded' | 'purge.completed' }
>

/**
 * Everything one session's stream produces: its start, its states, its compactions,
 * the tools it used, what each turn cost, its end, its purges, and the one fault
 * this loop refuses to route around (§8).
 *
 * `turn.usage_recorded` is here because the fleet is the measurer under fleetd
 * (§6.2): the turn boundary is where the provider's numbers are, and a session
 * the supervisor owns has no Stop hook to ask.
 *
 * `provider.errored` is here for the last of those: the supervisor's own
 * invariant violation has no event of its own, and inventing one would ripple
 * through every projection and replay fixture for a record a reader already
 * knows how to read — `code: 'invariant'` is what makes it distinguishable, and
 * the store's failure notification is what makes somebody see it.
 *
 * `peer.failed` is here for the same reason from the other side: a failed turn
 * carries the provider's sentence about *why*, and §6.1's failure class is where
 * that sentence belongs — a state change says the peer failed, not what failed.
 */
export type SessionRecord =
  | PurgeRecord
  | Extract<
      AppendEvent,
      {
        type:
          | 'session.started'
          | 'peer.state_changed'
          | 'peer.compacted'
          | 'peer.tool_used'
          | 'peer.failed'
          | 'turn.usage_recorded'
          | 'session.ended'
          | 'provider.errored'
      }
    >

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

/**
 * `session.started` carries the mode the session is *running*, as a closed set; the handle holds a bare
 * `string`. Decoded for the same reason as the session id: a provider that invents a mode is a bug here, now.
 */
export const permissionModeOf = (handle: SessionHandle): PermissionMode => {
  const decoded = decodeStrict(permissionModeSchema(), handle.permissionMode)
  if (!decoded.ok) {
    throw fleetError(
      'internal',
      `provider ${handle.providerId} reports permission mode ${JSON.stringify(handle.permissionMode)}, which is not one the fleet knows`,
      { details: { peerId: handle.peerId }, cause: decoded.error },
    )
  }
  return decoded.value
}
