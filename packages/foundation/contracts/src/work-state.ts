/**
 * The work state machine (architecture §5.1). Transitions are pure functions
 * of events; the PM only appends the event that causes one. The order here is
 * the happy path, so a "has it moved forward" check is an index comparison.
 */

import { oneOf, type Schema } from '@fleet/foundation-core'

export const workStates = [
  'proposed',
  'needs_contract',
  'ready',
  'assigned',
  'in_progress',
  'in_review',
  'mergeable',
  'merged',
  'cleaned',
  'blocked',
  'cancelled',
] as const

export type WorkState = (typeof workStates)[number]

export const workState = (): Schema<WorkState> => oneOf(workStates)

/** The forward path; `blocked` and `cancelled` are the two side exits. */
export const workStatePath = [
  'proposed',
  'needs_contract',
  'ready',
  'assigned',
  'in_progress',
  'in_review',
  'mergeable',
  'merged',
  'cleaned',
] as const satisfies readonly WorkState[]

/** Why a Work is `blocked`; the PM's `unblock` rule routes by this (§5.2). */
export const blockReasons = ['user', 'contract', 'peer', 'external'] as const
export type BlockReason = (typeof blockReasons)[number]
export const blockReason = (): Schema<BlockReason> => oneOf(blockReasons)

/**
 * The phases a peer reports progress in (`work.noted`, §5.1). A closed list on
 * purpose: a board comment is only worth mirroring because every one of them
 * reads the same way, and the phase is what makes a note a status rather than
 * chatter. `blocked` is the one with a consequence — the PM raises a decision
 * for it, so a peer's "I cannot go on" reaches the person who can answer.
 */
export const workNotePhases = ['plan', 'implement', 'mr', 'blocked'] as const
export type WorkNotePhase = (typeof workNotePhases)[number]
export const workNotePhase = (): Schema<WorkNotePhase> => oneOf(workNotePhases)

/** Nothing more happens to a Work in these states. */
export const isWorkTerminal = (state: WorkState): boolean => state === 'cleaned' || state === 'cancelled'

/** Can be handed to a peer once one is idle (§5.2 `assign`). */
export const isAssignable = (state: WorkState): boolean => state === 'ready'

/** The PM must not create a second Work for the same intent (§5.2 `dedupe`). */
export const isOpen = (state: WorkState): boolean => !isWorkTerminal(state)
