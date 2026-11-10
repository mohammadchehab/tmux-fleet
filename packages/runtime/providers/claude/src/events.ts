/**
 * The adapter's event vocabulary — which is now nearly the contract's own.
 *
 * Contracts E (§4) widened `ProviderEvent` to say the things this adapter had
 * been projecting away: `question.asked` carries its `questionId` and the
 * structured choices, `approval.requested` exists at all, `turn.ended` carries
 * the `reason` the "notify on failure only" rule reads (§6.1), and
 * `session.ended` names whether the session exited, crashed or was stopped. So
 * the adapter emits contract events as themselves and the old lossy projection
 * is gone.
 *
 * Two events the contract still has no member for stay internal here:
 *
 * - `session.started`, because §4 only names the end of a session. It is how
 *   the adapter learns the model, the permission mode and the vendor ref, and
 *   how `start()` notices a launch landed somewhere other than the spec said.
 * - `tool.denied`, emitted when the session's own tool policy refuses a call.
 *   `SessionSpec.toolPolicy` is not in the contracts yet (engineer-1's
 *   follow-up); the pair lands together.
 *
 * `AskedQuestion` is the contract's `ProviderQuestion` under the name the
 * question helpers use.
 */

import type { Timestamp, TurnId } from '@fleet/foundation-core'
import type { ProviderEvent, ProviderQuestion, ProviderSessionRef } from '@fleet/runtime-provider-sdk'

export type AskedQuestion = ProviderQuestion

/** Why a turn stopped. Only `failed` notifies a person (§6.1). */
export type { TurnEndReason } from '@fleet/runtime-provider-sdk'

/** Everything the adapter emits. Two members are not in the contract yet. */
export type AdapterEvent =
  | ProviderEvent
  | {
      readonly type: 'session.started'
      readonly at: Timestamp
      readonly sessionRef: ProviderSessionRef
      readonly model: string
      readonly permissionMode: string
    }
  | {
      readonly type: 'tool.denied'
      readonly turnId: TurnId
      readonly tool: string
      readonly summary?: string
    }

/** True for the events `ProviderEvent` can carry, so `events()` hands over exactly those. */
export const isContractEvent = (event: AdapterEvent): event is ProviderEvent =>
  event.type !== 'session.started' && event.type !== 'tool.denied'
