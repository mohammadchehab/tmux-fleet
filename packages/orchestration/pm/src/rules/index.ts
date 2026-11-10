/**
 * The rule table (architecture §5.2, §10), as one export: the order here *is* the precedence.
 *
 * §5.2's table reads top-down as "what the tick does first", with two orderings the table leaves implicit and §10
 * settles:
 *
 * 1. **`retarget` before `merge`.** A dependent whose parent just merged is moved onto the parent's base in the same
 *    tick that would otherwise merge it — and because it moved, `mergeBlocker` then refuses it (§10).
 * 2. **`supersede_brief` before `assign`.** A stale brief is corrected before any new Work is handed out, so a peer
 *    is never briefed twice in one tick.
 * 3. **`unblock` after `request_decisions`, before `idle`.** The user-facing rules speak first, so a Work they
 *    already put a question about is not asked about a second way; and §5.2's row order is `unblock`, then `idle`.
 *
 * `dedupe` before `assign` is not implicit — §5.2 says it — and is why a rule takes a `questioned` set.
 */

export { draft } from './context.ts'
export type { Draft, Rule, RuleContext } from './context.ts'
export { assignReadyWork } from './assign.ts'
export { questionDuplicates, questionThinCards, similarity } from './dedupe.ts'
export { requestDecisions } from './escalate.ts'
export {
  approvalDecisionId,
  approvalInputsHash,
  mergeBlocker,
  mergeGreenPrs,
  retargetDependents,
} from './gate.ts'
export { raiseCapacityGaps } from './idle.ts'
export { markReadyWork } from './ready.ts'
export { blockedDecisionId, unblockWaitingPeers } from './unblock.ts'
export { supersedeStaleBriefs } from './stale.ts'
export { renderStandupDue } from './standup.ts'

import { assignReadyWork } from './assign.ts'
import { questionDuplicates, questionThinCards } from './dedupe.ts'
import { requestDecisions } from './escalate.ts'
import { mergeGreenPrs, retargetDependents } from './gate.ts'
import { raiseCapacityGaps } from './idle.ts'
import { markReadyWork } from './ready.ts'
import { unblockWaitingPeers } from './unblock.ts'
import { supersedeStaleBriefs } from './stale.ts'
import { renderStandupDue } from './standup.ts'
import type { Rule } from './context.ts'

/** §5.2's rules in the order a tick applies them. `decide` runs exactly this list. */
export const pmRules: readonly Rule[] = [
  retargetDependents,
  mergeGreenPrs,
  supersedeStaleBriefs,
  questionDuplicates,
  questionThinCards,
  markReadyWork,
  assignReadyWork,
  requestDecisions,
  unblockWaitingPeers,
  raiseCapacityGaps,
  renderStandupDue,
]
