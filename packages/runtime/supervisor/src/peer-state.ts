/**
 * Provider events → the peer state the fleet shows (§2, §4).
 *
 * The Supervisor maps; it does not infer. Every state below comes from a typed
 * event, never from a regex on text or a read of a transcript, and the mapping
 * is pure so a replayed window produces the same states (§5.4).
 */

import type { PeerState } from '@fleet/foundation-core'
import type { ProviderEvent } from '@fleet/foundation-contracts'

/**
 * The state a peer is in after this event, or `undefined` when the event does
 * not change it (a `tool.use` during a turn is still `working`).
 *
 * `session.ended {reason: 'stopped'}` is `ended`, not `failed`: a session the
 * fleet stopped on purpose is finished, and calling it a failure would page
 * someone every purge (§8).
 */
export const peerStateOf = (event: ProviderEvent): PeerState | undefined => {
  switch (event.type) {
    case 'turn.started':
    case 'tool.use':
      return 'working'
    case 'question.asked':
    case 'approval.requested':
      return 'waiting_input'
    case 'question.abandoned':
      // The question died with its session; the peer is no longer waiting on it.
      return 'working'
    case 'turn.ended':
      // Only a failed turn is a failure; an interrupt is a decision, not a fault (§4).
      return event.reason === 'failed' ? 'failed' : 'idle'
    case 'session.ended':
      return event.reason === 'crash' ? 'failed' : 'ended'
    case 'error':
      return 'failed'
    case 'compaction':
      // Compaction is information: the session is alive and got smaller.
      return undefined
  }
}
